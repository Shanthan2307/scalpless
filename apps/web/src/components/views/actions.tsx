'use client';

// Shared action runner: sign + execute a transaction with the connected wallet, surface the
// Suiscan link, translate Move aborts into plain language, and refresh every chain query.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Transaction } from '@mysten/sui/transactions';
import { signAndExecute } from '../../lib/dapp-kit';
import { NETWORK } from '../../lib/constants';

// module → abort code → explanation (mirrors the constants in packages/sui-contracts/sources).
const ABORTS: Record<string, string[]> = {
  registry: ['World ID attestation expired — try again', 'Attestation signature invalid', 'Attestation is for a different action', 'Attestation is for a different object', 'Attestation was issued to a different wallet'],
  passport: ['This human already has a Credit Passport (one per human)', 'This wallet is already bound to a human', 'No Credit Passport — mint one on the World ID page', 'This wallet is not allowed to act for that human', 'Only the passport owner can do that', 'Too many agents delegated', 'An active loan must be repaid first'],
  claim: ['Only the claim holder can do that', 'Claim is not in the right state for this step', 'Claim window has expired', 'This World ID is not the winner of the claim'],
  drop: ['Drop is not open', 'Entries are closed', 'You already entered this drop (one entry per human)', 'Your World ID tier is too low for this drop', 'Deposit must be exactly 10% of face price', 'Drop is full', 'The draw opens when entries close', 'Locked out after a loan default', 'Invalid drop parameters'],
  settlement: ['Claim belongs to a different drop', 'Wrong payment amount', 'Layaway plan is not active', 'Installment is past due', 'Layaway not fully paid yet', 'No installment is overdue yet', 'Wrong claim for this plan'],
  lending: ['Amount must be greater than zero', 'Not enough liquidity in the pool', 'No underwriting decision — request terms first', 'Underwriting terms expired — request again', 'Loan exceeds underwritten terms', 'Loan exceeds your credit limit', 'Locked out after a loan default', 'No active loan', 'Borrower is not behind schedule', 'Grace period has not passed yet', 'Already marked late', 'Loan term + grace has not passed yet', 'Invalid parameters', 'Claim belongs to a different drop', 'LP cap already used'],
  market: ['Scalping blocked: price is above 110% of face value', 'Claim is not listed', 'Only the seller can delist', 'Payment must equal the asking price', 'You already bought a resale claim from this drop (one per human)', "You can't buy your own listing", 'Locked out after a loan default'],
};

export function explainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /abort code: (\d+), in '0x[0-9a-f]+::(\w+)::/.exec(msg);
  if (m) {
    const text = ABORTS[m[2]]?.[Number(m[1])];
    if (text) return `${text} (on-chain abort ${m[2]}:${m[1]})`;
  }
  if (/rejected|denied|cancel/i.test(msg)) return 'Cancelled in wallet';
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

export const suiscanTx = (digest: string) => `https://suiscan.xyz/${NETWORK}/tx/${digest}`;
export const suiscanObject = (id: string) => `https://suiscan.xyz/${NETWORK}/object/${id}`;

interface Result {
  label: string;
  digest?: string;
  error?: string;
}

interface ActionsState {
  busy: string | null;
  result: Result | null;
  run: (label: string, build: () => Promise<Transaction> | Transaction) => Promise<boolean>;
  clear: () => void;
}

const Ctx = createContext<ActionsState | null>(null);

export function ActionsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const run = useCallback(
    async (label: string, build: () => Promise<Transaction> | Transaction) => {
      setBusy(label);
      setResult(null);
      try {
        const tx = await build();
        const t = await signAndExecute(tx);
        setResult({ label, digest: t.digest });
        await queryClient.invalidateQueries();
        return true;
      } catch (err) {
        setResult({ label, error: explainError(err) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [queryClient],
  );

  return <Ctx.Provider value={{ busy, result, run, clear: () => setResult(null) }}>{children}</Ctx.Provider>;
}

export function useActions(): ActionsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useActions must be used within <ActionsProvider>');
  return ctx;
}

/** Fixed toast showing the latest transaction result. */
export function TxToast() {
  const { busy, result, clear } = useActions();
  if (!busy && !result) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-md border border-[#111111] bg-white p-4 text-[12px] font-mono shadow-lg">
      {busy && <div>⏳ {busy}… confirm in your wallet</div>}
      {result?.digest && (
        <div className="text-emerald-800">
          ✓ {result.label} ·{' '}
          <a className="underline" href={suiscanTx(result.digest)} target="_blank" rel="noreferrer">
            {result.digest.slice(0, 10)}…
          </a>
        </div>
      )}
      {result?.error && (
        <div className="text-red-800">
          ✕ {result.label}: {result.error}
        </div>
      )}
      {result && (
        <button onClick={clear} className="mt-2 text-[10px] uppercase text-[#6B6B6B] underline">
          dismiss
        </button>
      )}
    </div>
  );
}
