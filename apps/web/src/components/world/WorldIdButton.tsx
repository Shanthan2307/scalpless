'use client';

// Header World ID control (modeled on Proof-Of-Human-Drops components/world-id-signin.tsx).
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useWorldId } from './WorldIdProvider';

const btn =
  'h-10 px-4 text-[11px] font-mono uppercase tracking-[0.1em] border border-[#111111] transition-all disabled:opacity-50';

export function WorldIdButton() {
  const account = useCurrentAccount();
  const { session, walletMismatch, loading, phase, step, error, signIn, signOut } = useWorldId();

  if (session && !walletMismatch) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="hidden sm:inline-flex items-center gap-1.5 border border-emerald-700/40 bg-emerald-50 px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-emerald-900"
          title={`${session.tierName} · credentials: ${session.credentials.join(', ')}`}
        >
          ✓ Human · T{session.tier} · {session.humanKeyShort}
        </span>
        <button onClick={() => void signOut()} className={`${btn} bg-transparent text-[#111111] hover:bg-[#111111] hover:text-[#FAFAF7]`}>
          Sign out
        </button>
      </div>
    );
  }

  const label =
    phase === 'preparing' ? 'Preparing…'
    : phase === 'verifying' ? 'Scan in World App…'
    : phase === 'submitting' ? 'Verifying proof…'
    : walletMismatch ? 'Re-verify for this wallet'
    : 'Verify with World ID';

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={() => void signIn()}
        disabled={!account || loading || phase !== 'idle'}
        title={account ? undefined : 'Connect a Sui wallet first'}
        className={`${btn} bg-[#111111] text-[#FAFAF7] hover:bg-transparent hover:text-[#111111]`}
      >
        {label}
      </button>
      {step && phase !== 'idle' && <span className="mt-1 max-w-[260px] text-right text-[10px] font-mono text-[#6B6B6B]">{step}</span>}
      {error && <span className="mt-1 max-w-[260px] text-right text-[10px] font-mono text-red-700">{error}</span>}
    </div>
  );
}
