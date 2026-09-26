// Underwriter: reads the borrower's on-chain Credit Passport and the pool, decides terms with a
// published policy, and writes them on-chain with the UnderwriterCap (lending::set_terms —
// EthGlobal26's LoanRegistry.setTerms). The memo is hashed into the terms so the decision is
// auditable; the contract still enforces the passport's credit limit on its own.
import { createHash } from 'crypto';
import { Transaction } from '@mysten/sui/transactions';
import { env } from '../config/env';
import { executeAsOperator, objectJson, tableEntry } from './chain.service';

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

  // Fee for the whole term: Orb 5%, document 8%; +4% while Late; −1% per on-time repayment; floor 2%.
  let fee = p.credential_tier >= 3 ? 500 : 800;
  if (p.standing === 1) fee += 400;
  fee = Math.max(200, fee - 100 * passport.on_time_repayments);
  const riskBand = p.standing === 1 ? 3 : passport.on_time_repayments + passport.completed_layaways > 0 ? 1 : 2;

  reasons.push(
    `World ID tier ${p.credential_tier} (${p.credential_tier >= 3 ? 'Orb' : 'document'}), standing ${passport.standing}`,
    `On-chain history: ${passport.on_time_repayments} loans repaid on time, ${passport.completed_layaways} layaways completed, ${p.late_marks} late marks`,
    `Limit = min(passport credit limit ${Number(limit) / 1e9} SUI, pool liquidity ${Number(cash) / 1e9} SUI)`,
    'Repayment: 4 installments; resale proceeds repay the loan first; junior tranche takes first loss',
  );

  const memo = { policy: 'scalpless-underwriting-v1', human_key: humanKeyHex, passport, pool_cash_mist: cash.toString(), max_principal_mist: maxPrincipal.toString(), fee_bps: fee, risk_band: riskBand, expiry_ms, reasons };
  const memoHash = createHash('sha256').update(JSON.stringify(memo)).digest();

  const capId = process.env.SUI_UNDERWRITER_CAP_ID?.trim();
  if (!capId) throw new Error('[env] SUI_UNDERWRITER_CAP_ID is not set (run pnpm deploy:sui)');
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.PACKAGE_ID}::lending::set_terms`,
    arguments: [
      tx.object(capId),
      tx.object(env.LENDING_POOL_OBJECT_ID),
      tx.pure.vector('u8', Array.from(humanKey)),
      tx.pure.u64(maxPrincipal),
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
    max_principal_mist: maxPrincipal.toString(),
    fee_bps: fee,
    risk_band: riskBand,
    memo_hash: memoHash.toString('hex'),
    expiry_ms,
    tx_digest: digest,
    passport,
  };
}
