// Sui → MultiBaas mirror. Follows Scalpless events on Sui (GraphQL, cursor-paged, persisted) and
// records each claim lifecycle step and credit event on the ScalplessRWALedger through MultiBaas.
// A failed write stops the batch and is retried on the next tick: events are never skipped.
import fs from 'fs';
import path from 'path';
import { fromBase58, fromBase64, toHex } from '@mysten/sui/utils';
import { env } from '../config/env';
import { gql } from './chain.service';
import { ledgerCall } from './multibaas.service';
import { onRedeemed } from './redemption.service';
import { getShopifyLink } from './shopify-links';

const FILE = path.resolve(__dirname, '../../data/mirror.json');
const TICK_MS = 10_000;

// Ledger enums (ScalplessRWALedger.Stage / .Credit)
const Stage = { Won: 1, LivenessVerified: 2, Paid: 3, Layaway: 4, Financed: 5, Listed: 6, Resold: 7, LayawayDefaulted: 10 } as const;
const Credit = { LoanOpened: 1, Repayment: 2, LoanClosed: 3, MarkedLate: 4, Defaulted: 5 } as const;
const ZERO = `0x${'00'.repeat(32)}`;

interface MirrorState {
  cursors: Record<string, string | null>; // per package id
  claimDrop: Record<string, string>; // claim id → drop id
  claimHolder: Record<string, string>; // claim id → current holder
  processed: number;
  lastError: string | null;
  lastRunAt: string | null;
}

function load(): MirrorState {
  const empty: MirrorState = { cursors: {}, claimDrop: {}, claimHolder: {}, processed: 0, lastError: null, lastRunAt: null };
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return empty;
  }
}
let state = load();
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
}

export const mirrorState = () => state;

const b32 = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
const digestB32 = (digest: string) => `0x${toHex(fromBase58(digest))}`;
const humanB32 = (b64: string) => `0x${toHex(fromBase64(b64))}`;

interface SuiEvent {
  type: string;
  json: Record<string, any>;
  digest: string;
}

type Hook = (e: SuiEvent) => Promise<void>;
const hooks: Record<string, Hook> = {};
/** Extra handling for an event type (e.g. the Shopify app turns `Redeemed` into an order). */
export function onSuiEvent(name: string, hook: Hook) {
  hooks[name] = hook;
}

async function stage(claimId: string, stageId: number, digest: string, holder?: string) {
  const dropId = state.claimDrop[claimId];
  if (!dropId) return; // claim from a drop we never saw created — nothing to anchor it to
  if (holder) state.claimHolder[claimId] = holder;
  await ledgerCall('recordStage', [b32(claimId), b32(dropId), stageId, b32(state.claimHolder[claimId] ?? ZERO), digestB32(digest)]);
}

async function credit(humanKeyB64: string, kind: number, amount: string | number, digest: string) {
  await ledgerCall('recordCredit', [humanB32(humanKeyB64), kind, String(amount), digestB32(digest)]);
}

async function handle(e: SuiEvent) {
  const name = e.type.split('::').pop()!;
  const j = e.json;
  switch (name) {
    case 'DropCreated':
      await ledgerCall('listDrop', [b32(j.drop_id), j.title, getShopifyLink(j.drop_id)?.variantId ?? '', j.face_price_mist, j.total_units, digestB32(e.digest)]);
      break;
    case 'Won':
      state.claimDrop[j.claim_id] = j.drop_id;
      await stage(j.claim_id, Stage.Won, e.digest, j.winner);
      break;
    case 'LivenessVerified':
      await stage(j.claim_id, Stage.LivenessVerified, e.digest);
      break;
    case 'PaidInFull':
    case 'LayawayCompleted':
    case 'Delisted':
      await stage(j.claim_id, Stage.Paid, e.digest);
      break;
    case 'LayawayStarted':
      await stage(j.claim_id, Stage.Layaway, e.digest);
      break;
    case 'LayawayDefaulted':
      await stage(j.claim_id, Stage.LayawayDefaulted, e.digest, j.next_holder ?? ZERO);
      break;
    case 'LoanOpened':
      await stage(j.claim_id, Stage.Financed, e.digest);
      await credit(j.human_key, Credit.LoanOpened, j.principal_mist, e.digest);
      break;
    case 'Repaid':
      await credit(j.human_key, Credit.Repayment, (BigInt(j.principal_mist) + BigInt(j.fee_mist)).toString(), e.digest);
      break;
    case 'LoanClosed':
      await credit(j.human_key, Credit.LoanClosed, 0, e.digest);
      break;
    case 'MarkedLate':
      await credit(j.human_key, Credit.MarkedLate, j.paid_mist, e.digest);
      break;
    case 'Defaulted':
      await credit(j.human_key, Credit.Defaulted, j.loss_mist, e.digest);
      break;
    case 'Listed':
      await stage(j.claim_id, Stage.Listed, e.digest);
      break;
    case 'Redeemed': {
      // Burned on Sui → Shopify order (if the store is connected) → recorded on the ledger.
      const order = await onRedeemed(j.claim_id, e.digest, j.item_name);
      if (state.claimDrop[j.claim_id]) await ledgerCall('recordRedeemed', [b32(j.claim_id), order, digestB32(e.digest)]);
      break;
    }
    case 'Sold':
      await stage(j.claim_id, Stage.Resold, e.digest, j.buyer);
      break;
    default:
      break; // deposits, entries, refunds, terms, passports: not part of the claim / credit record
  }
  await hooks[name]?.(e);
}

async function pull(pkg: string) {
  const data = await gql<{ events: { pageInfo: { hasNextPage: boolean }; edges: { cursor: string; node: { contents: { type: { repr: string }; json: any }; transaction: { digest: string } } }[] } }>(
    `query($type: String!, $after: String) {
      events(filter: { type: $type }, first: 20, after: $after) {
        pageInfo { hasNextPage }
        edges { cursor node { contents { type { repr } json } transaction { digest } } }
      }
    }`,
    { type: pkg, after: state.cursors[pkg] ?? null },
  );
  // The cursor advances after every recorded event, so a failure resumes exactly where it stopped
  // and nothing is written twice.
  for (const { cursor, node } of data.events.edges) {
    await handle({ type: node.contents.type.repr, json: node.contents.json, digest: node.transaction.digest });
    state.processed += 1;
    state.cursors[pkg] = cursor;
    save();
  }
  return data.events.pageInfo.hasNextPage;
}

let running = false;
export async function mirrorTick() {
  if (running) return;
  running = true;
  try {
    for (const pkg of [...new Set([env.PACKAGE_ID, env.CALL_PACKAGE_ID])]) {
      while (await pull(pkg)) {
        /* drain */
      }
    }
    state.lastError = null;
  } catch (err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    state.lastError = data ? JSON.stringify(data).slice(0, 300) : err instanceof Error ? err.message : String(err);
    console.warn('[mirror]', state.lastError);
  } finally {
    state.lastRunAt = new Date().toISOString();
    save();
    running = false;
  }
}

export function startMirror() {
  if (!process.env.RWA_LEDGER_ADDRESS) {
    console.log('[mirror] RWA_LEDGER_ADDRESS not set — run pnpm deploy:ledger; mirror disabled');
    return;
  }
  console.log('[mirror] following Scalpless events on Sui → MultiBaas RWA ledger');
  void mirrorTick();
  setInterval(() => void mirrorTick(), TICK_MS);
}
