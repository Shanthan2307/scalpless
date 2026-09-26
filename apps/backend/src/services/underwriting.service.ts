// Underwriter: reads the borrower's on-chain Credit Passport and the pool, decides terms with a
// published policy, and writes them on-chain with the UnderwriterCap (lending::set_terms —
// EthGlobal26's LoanRegistry.setTerms). The memo is hashed into the terms so the decision is
// auditable; the contract still enforces the passport's credit limit on its own.
import { createHash } from 'crypto';
import { Transaction } from '@mysten/sui/transactions';
import { env } from '../config/env';
import { executeAsOperator, objectJson, tableEntry } from './chain.service';
import { geminiJson } from './gemini.service';
import { ledgerEvents } from './multibaas.service';

const TERMS_TTL_MS = 30 * 60 * 1000;

interface PassportJson {
  owner: string;
  credential_tier: number;
  standing: number;
  score: string;
  credit_limit_mist: string;
  on_time_repayments: string;
  late_marks: string;
  defaults: string;
  completed_layaways: string;
  active_loan: boolean;
}

interface PoolJson {
  cash: string | { value: string };
  loans: { id: string };
  terms: { id: string };
}

export interface UnderwritingDecision {
  approved: boolean;
  reasons: string[];
  max_principal_mist: string;
  fee_bps: number;
  risk_band: number;
  memo_hash: string;
  expiry_ms: number;
  tx_digest?: string;
  ai?: { model: string; memo: string } | { unavailable: string };
  passport?: { tier: number; standing: string; credit_limit_mist: string; on_time_repayments: number; completed_layaways: number; score: number };
}

const STANDING = ['good', 'late', 'locked_out'];
const cashOf = (c: PoolJson['cash']) => BigInt(typeof c === 'string' ? c : c.value);

export async function underwrite(humanKeyHex: string): Promise<UnderwritingDecision> {
  const humanKey = Buffer.from(humanKeyHex.replace(/^0x/, ''), 'hex');
  const preg = await objectJson<{ passports: { id: string } }>(env.PASSPORT_REGISTRY_ID);
  const pool = await objectJson<PoolJson>(env.LENDING_POOL_OBJECT_ID);
  if (!preg || !pool) throw new Error('Scalpless contracts not found on-chain — deploy first');
  const p = await tableEntry<PassportJson>(preg.passports.id, humanKey);

  const reasons: string[] = [];
  const expiry_ms = Date.now() + TERMS_TTL_MS;
  const decline = (why: string): UnderwritingDecision => ({
    approved: false, reasons: [...reasons, why], max_principal_mist: '0', fee_bps: 0, risk_band: 0, memo_hash: '', expiry_ms,
  });

  if (!p) return decline('No Credit Passport on-chain — mint one with World ID first.');
  const passport = {
    tier: p.credential_tier,
    standing: STANDING[p.standing] ?? 'unknown',
    credit_limit_mist: p.credit_limit_mist,
    on_time_repayments: Number(p.on_time_repayments),
    completed_layaways: Number(p.completed_layaways),
    score: Number(p.score),
  };
  if (p.standing === 2) return { ...decline('Locked out after a default: no further credit on any wallet.'), passport };
  if (p.active_loan) return { ...decline('An active loan must be repaid first.'), passport };
  if (p.credential_tier < 2) return { ...decline('Uncollateralized credit needs an Orb or passport World ID credential.'), passport };

  const limit = BigInt(p.credit_limit_mist);
  const cash = cashOf(pool.cash);
  const maxPrincipal = limit < cash ? limit : cash;
  if (maxPrincipal === 0n) return { ...decline(limit === 0n ? 'Credit limit is 0.' : 'Lending pool has no available liquidity.'), passport };

  // Policy bounds. Fee for the whole term: Orb 5%, document 8%; +4% while Late; −1% per on-time
  // repayment; floor 2%. The AI agent may only tighten these (lower principal, higher fee).
  let policyFee = p.credential_tier >= 3 ? 500 : 800;
  if (p.standing === 1) policyFee += 400;
  policyFee = Math.max(200, policyFee - 100 * passport.on_time_repayments);
  const policyBand = p.standing === 1 ? 3 : passport.on_time_repayments + passport.completed_layaways > 0 ? 1 : 2;

  reasons.push(
    `World ID tier ${p.credential_tier} (${p.credential_tier >= 3 ? 'Orb' : 'document'}), standing ${passport.standing}`,
    `On-chain history: ${passport.on_time_repayments} loans repaid on time, ${passport.completed_layaways} layaways completed, ${p.late_marks} late marks`,
    `Policy cap = min(passport credit limit ${Number(limit) / 1e9} SUI, pool liquidity ${Number(cash) / 1e9} SUI); policy fee ${policyFee / 100}%`,
  );

  // Credit history recorded on the MultiBaas RWA ledger (Base Sepolia).
  let history: { kind: string; amountMist: string; at: string }[] = [];
  if (process.env.RWA_LEDGER_ADDRESS) {
    try {
      const KIND = ['None', 'Loan opened', 'Repayment', 'Loan closed', 'Marked late', 'Defaulted'];
      const key = humanKeyHex.toLowerCase();
      history = (await ledgerEvents({ eventSignature: 'CreditEvent(bytes32,uint8,uint64,bytes32)' }))
        .filter((e) => e.inputs.humanKey?.toLowerCase() === key)
        .map((e) => ({ kind: KIND[Number(e.inputs.kind)], amountMist: e.inputs.amountMist, at: e.triggeredAt }));
    } catch {
      /* ledger unreachable: underwrite from the passport alone */
    }
  }

  let maxPrincipalFinal = maxPrincipal;
  let fee = policyFee;
  let riskBand = policyBand;
  let ai: UnderwritingDecision['ai'];
  try {
    const out = await geminiJson<{ max_principal_sui: number; fee_bps: number; risk_band: number; memo: string; factors: string[] }>(
      'You are the underwriting agent of Scalpless, an uncollateralized ("borrow on yourself") lending protocol on Sui. ' +
        'Borrowers are World ID-verified unique humans; a default locks them out on every wallet and the junior tranche takes the loss. ' +
        'Decide terms WITHIN the policy bounds given: you may lower the principal or raise the fee, never the reverse. Be concise and factual.',
      JSON.stringify({
        passport,
        late_marks: Number(p.late_marks),
        defaults: Number(p.defaults),
        credit_history_on_multibaas_ledger: history,
        pool_liquidity_sui: Number(cash) / 1e9,
        policy_bounds: { max_principal_sui: Number(maxPrincipal) / 1e9, min_fee_bps: policyFee, max_fee_bps: 3000, policy_risk_band: policyBand },
        loan_structure: '4 equal installments over the pool term; resale proceeds repay the loan first',
      }),
      {
        type: 'OBJECT',
        properties: {
          max_principal_sui: { type: 'NUMBER' },
          fee_bps: { type: 'INTEGER' },
          risk_band: { type: 'INTEGER', description: '1 low, 2 medium, 3 high' },
          memo: { type: 'STRING', description: 'Two-sentence credit memo' },
          factors: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['max_principal_sui', 'fee_bps', 'risk_band', 'memo', 'factors'],
      },
    );
    // Clamp: the model can only tighten the policy.
    const proposed = BigInt(Math.max(0, Math.floor(out.max_principal_sui * 1e9)));
    maxPrincipalFinal = proposed < maxPrincipal ? proposed : maxPrincipal;
    fee = Math.min(3000, Math.max(policyFee, Math.round(out.fee_bps)));
    riskBand = Math.min(3, Math.max(policyBand, Math.round(out.risk_band)));
    ai = { model: out._model, memo: out.memo };
    reasons.push(`AI agent (${out._model}): ${out.memo}`, ...out.factors.slice(0, 4).map((f) => `AI factor: ${f}`));
  } catch (err) {
    ai = { unavailable: err instanceof Error ? err.message : String(err) };
    reasons.push('AI agent unavailable — terms are the policy decision.');
  }
  if (maxPrincipalFinal === 0n) return { ...decline('The AI agent declined to extend credit.'), passport, ai };
  reasons.push('Repayment: 4 installments; resale proceeds repay the loan first; junior tranche takes first loss');

  const memo = { policy: 'scalpless-underwriting-v2', human_key: humanKeyHex, passport, credit_history: history, pool_cash_mist: cash.toString(), max_principal_mist: maxPrincipalFinal.toString(), fee_bps: fee, risk_band: riskBand, expiry_ms, reasons, ai };
  const memoHash = createHash('sha256').update(JSON.stringify(memo)).digest();

  const capId = process.env.SUI_UNDERWRITER_CAP_ID?.trim();
  if (!capId) throw new Error('[env] SUI_UNDERWRITER_CAP_ID is not set (run pnpm deploy:sui)');
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.CALL_PACKAGE_ID}::lending::set_terms`,
    arguments: [
      tx.object(capId),
      tx.object(env.LENDING_POOL_OBJECT_ID),
      tx.pure.vector('u8', Array.from(humanKey)),
      tx.pure.u64(maxPrincipalFinal),
      tx.pure.u64(fee),
      tx.pure.u8(riskBand),
      tx.pure.vector('u8', Array.from(memoHash)),
      tx.pure.u64(expiry_ms),
    ],
  });
  const digest = await executeAsOperator(tx);

  return {
    approved: true,
    reasons,
    max_principal_mist: maxPrincipalFinal.toString(),
    fee_bps: fee,
    risk_band: riskBand,
    memo_hash: memoHash.toString('hex'),
    expiry_ms,
    tx_digest: digest,
    passport,
    ai,
  };
}
