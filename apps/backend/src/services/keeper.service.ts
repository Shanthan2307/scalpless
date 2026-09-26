// Keeper agent: enforces loan and layaway schedules on Sui. The decision to act is deterministic —
// it only calls functions whose on-chain preconditions have passed (the contract re-checks them);
// Gemini writes the human-readable reason for each action. Runs when triggered (POST
// /api/keeper/run) or on a timer if KEEPER_AUTORUN=true.
import fs from 'fs';
import path from 'path';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toHex } from '@mysten/sui/utils';
import { env } from '../config/env';
import { executeAsOperator, gql, objectJson } from './chain.service';
import { geminiJson } from './gemini.service';

const FILE = path.resolve(__dirname, '../../data/agent-activity.json');
const INSTALLMENTS = 4;

export interface Activity {
  at: string;
  action: 'mark_late' | 'mark_default' | 'default_layaway';
  subject: string;
  reason: string;
  model?: string;
  txDigest?: string;
  error?: string;
}

function loadActivity(): Activity[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}
let activity = loadActivity();
function record(a: Activity) {
  activity = [a, ...activity].slice(0, 100);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(activity, null, 2));
}
export const keeperActivity = () => activity;

interface PoolJson { term_ms: string; grace_ms: string; loans: { id: string } }
interface LoanJson { borrower: string; principal_mist: string; fee_mist: string; repaid_principal_mist: string; repaid_fee_mist: string; installment_mist: string; started_ms: string; late_marked: boolean }
interface PlanJson { claim_id: string; drop_id: string; buyer: string; installments_paid: number; next_due_ms: string; status: number; paid_mist: string; total_mist: string }

interface Candidate {
  action: Activity['action'];
  subject: string;
  facts: Record<string, unknown>;
  build: () => Transaction;
}

async function candidates(now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const pool = await objectJson<PoolJson>(env.LENDING_POOL_OBJECT_ID);
  if (pool) {
    const loans = await gql<{ address: { dynamicFields: { nodes: { name: { json: string }; value: { json: LoanJson } }[] } } | null }>(
      `query($t: SuiAddress!) { address(address: $t) { dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } } } }`,
      { t: pool.loans.id },
    );
    const term = Number(pool.term_ms);
    const grace = Number(pool.grace_ms);
    for (const { name, value: { json: l } } of loans.address?.dynamicFields.nodes ?? []) {
      const humanKey = `0x${toHex(fromBase64(name.json))}`;
      const start = Number(l.started_ms);
      const interval = term / INSTALLMENTS;
      const dueCount = Math.min(INSTALLMENTS, Math.floor((now - start) / interval));
      const paid = BigInt(l.repaid_principal_mist) + BigInt(l.repaid_fee_mist);
      const total = BigInt(l.principal_mist) + BigInt(l.fee_mist);
      const expectedRaw = BigInt(dueCount) * BigInt(l.installment_mist);
      const expected = expectedRaw < total ? expectedRaw : total;
      const facts = { borrower: l.borrower, owed_sui: Number(total - paid) / 1e9, paid_sui: Number(paid) / 1e9, expected_by_now_sui: Number(expected) / 1e9, installments_due: dueCount, minutes_since_start: Math.round((now - start) / 60_000) };
      const call = (fn: 'mark_late' | 'mark_default') => () => {
        const tx = new Transaction();
        tx.moveCall({ target: `${env.CALL_PACKAGE_ID}::lending::${fn}`, arguments: [tx.object(env.LENDING_POOL_OBJECT_ID), tx.object(env.PASSPORT_REGISTRY_ID), tx.pure.vector('u8', Array.from(fromBase64(name.json))), tx.object('0x6')] });
        return tx;
      };
      if (now >= start + term + grace && paid < total) {
        out.push({ action: 'mark_default', subject: humanKey, facts: { ...facts, rule: 'term + grace elapsed with balance outstanding' }, build: call('mark_default') });
      } else if (!l.late_marked && paid < expected && now >= start + dueCount * interval + grace) {
        out.push({ action: 'mark_late', subject: humanKey, facts: { ...facts, rule: 'installment missed and grace elapsed' }, build: call('mark_late') });
      }
    }
  }
  const plans = await gql<{ objects: { nodes: { address: string; asMoveObject: { contents: { json: PlanJson } } }[] } }>(
    `query($type: String!) { objects(filter: { type: $type }, first: 50) { nodes { address asMoveObject { contents { json } } } } }`,
    { type: `${env.PACKAGE_ID}::settlement::LayawayPlan` },
  );
  for (const { address: planId, asMoveObject: { contents: { json: p } } } of plans.objects.nodes) {
    if (p.status !== 0 || p.installments_paid >= INSTALLMENTS || now <= Number(p.next_due_ms)) continue;
    out.push({
      action: 'default_layaway',
      subject: planId,
      facts: { buyer: p.buyer, installments_paid: p.installments_paid, paid_sui: Number(p.paid_mist) / 1e9, total_sui: Number(p.total_mist) / 1e9, minutes_overdue: Math.round((now - Number(p.next_due_ms)) / 60_000), rule: 'installment overdue: refund 95%, pass claim to waitlist' },
      build: () => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${env.CALL_PACKAGE_ID}::settlement::default_layaway`,
          arguments: [tx.object(planId), tx.object(p.drop_id), tx.object(env.LENDING_POOL_OBJECT_ID), tx.object(env.PASSPORT_REGISTRY_ID), tx.object(p.claim_id), tx.object('0x6')],
        });
        return tx;
      },
    });
  }
  return out;
}

async function explain(c: Candidate): Promise<{ reason: string; model?: string }> {
  try {
    const r = await geminiJson<{ reason: string }>(
      'You are the Scalpless keeper agent. In one plain-English sentence (max 30 words), explain to the borrower and lenders why this enforcement action is being taken. State facts only.',
      JSON.stringify({ action: c.action, ...c.facts }),
      { type: 'OBJECT', properties: { reason: { type: 'STRING' } }, required: ['reason'] },
    );
    return { reason: r.reason, model: r._model };
  } catch {
    return { reason: `${c.action}: ${String(c.facts.rule)}` };
  }
}

/** Find due enforcement actions; execute them unless `preview`. */
export async function runKeeper(preview: boolean): Promise<Activity[]> {
  const results: Activity[] = [];
  for (const c of await candidates(Date.now())) {
    const { reason, model } = await explain(c);
    const a: Activity = { at: new Date().toISOString(), action: c.action, subject: c.subject, reason, model };
    if (!preview) {
      try {
        a.txDigest = await executeAsOperator(c.build());
      } catch (err) {
        a.error = err instanceof Error ? err.message : String(err);
      }
      record(a);
    }
    results.push(a);
  }
  return results;
}

export function startKeeper() {
  if (process.env.KEEPER_AUTORUN !== 'true') return;
  console.log('[keeper] autorun every 60s');
  setInterval(() => void runKeeper(false).catch((e) => console.warn('[keeper]', e)), 60_000);
}
