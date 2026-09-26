'use client';

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { AgentsPanel } from '../world/AgentsPanel';
import { useWorldId } from '../world/WorldIdProvider';
import { useActions } from './actions';
import { usePassport } from '../../lib/hooks';
import { mist, STANDING } from '../../lib/chain';
import { mintPassportTx } from '../../lib/tx';
import { PASSPORT_REGISTRY_ID } from '../../lib/constants';
import { ObjLink, Stat } from './ui';

// Display only: the tier comes from the credentials World ID returns, never from user input.
const TIERS = [
  { tier: 1, title: 'Selfie Check', credential: 'World ID credential: selfie', tickets: 1, rounds: 'Round I only' },
  { tier: 2, title: 'Passport / NFC', credential: 'World ID credential: passport · mnc', tickets: 3, rounds: 'Rounds I & II' },
  { tier: 3, title: 'Orb Proof of Human', credential: 'World ID credential: proof_of_human', tickets: 6, rounds: 'Rounds I, II & III' },
] as const;

export default function WorldIdentityView() {
  const account = useCurrentAccount();
  const world = useWorldId();
  const { run, busy } = useActions();
  const session = world.session;
  const verified = !!session && !world.walletMismatch;
  const passport = usePassport(session?.humanKey);

  // Uses the World ID session (verifying first if needed), then the backend attestation.
  const mint = async () => {
    if ((!world.session || world.walletMismatch) && !(await world.signIn())) return;
    await run('Mint Credit Passport', async () => mintPassportTx(await world.attest('mint-credit-passport')));
  };

  return (
    <div className="animate-fade-in space-y-12 pb-24">
      <section id="identity" className="py-24 border-b border-[#E5E5E0]">
        <div className="mb-12">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-2">
            § 01 — IDENTITY & PROPORTIONATE TRUST LADDER
          </div>
          <h2 className="font-serif text-3xl md:text-4xl font-normal tracking-tight">
            Biological Personhood as Non-Financial Collateral
          </h2>
          <p className="text-[16px] text-[#6B6B6B] mt-2 max-w-[700px]">
            World ID proves you are a unique human without revealing who you are. Your tier is set by the
            strongest credential World App presents; it decides your raffle weight and later your credit ladder.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 border border-[#E5E5E0] divide-y md:divide-y-0 md:divide-x divide-[#E5E5E0] mb-8">
          {TIERS.map((t) => {
            const mine = verified && session!.tier === t.tier;
            return (
              <div key={t.tier} className={`p-6 ${mine ? 'bg-[#111111]/5' : ''}`}>
                <div className="flex items-center justify-between text-[11px] font-mono text-[#6B6B6B] uppercase tracking-[0.14em] mb-4">
                  <span>0{t.tier} / TIER {t.tier}</span>
                  {mine && <span className="text-emerald-800 font-bold">YOUR TIER</span>}
                </div>
                <h3 className="font-serif text-xl mb-1">{t.title}</h3>
                <div className="text-[12px] font-mono text-[#1D3557] mb-3">{t.credential}</div>
                <div className="text-[11px] font-mono uppercase tracking-[0.1em] text-[#111111] pt-3 border-t border-[#E5E5E0]">
                  Raffle Weight: {t.tickets} Ticket{t.tickets > 1 ? 's' : ''} · {t.rounds}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border border-[#E5E5E0] p-6 bg-white">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-4">
            Credit Passport · World ID → Sui
          </div>

          {!account && <p className="text-[14px] text-[#6B6B6B] mb-4">Connect a Sui wallet. Your World ID proof is bound to that wallet address.</p>}

          {account && !verified && (
            <p className="text-[14px] text-[#6B6B6B] mb-4">
              {world.walletMismatch
                ? 'You verified with a different wallet. Verify again to bind your World ID to this one.'
                : 'Not verified yet. Scan with World App to prove you are a unique human.'}
            </p>
          )}

          {verified && (
            <div className="mb-6 p-4 border border-[#E5E5E0] bg-[#FAFAF7] text-[12px] font-mono space-y-1.5">
              <div className="text-emerald-800 font-bold flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> WORLD ID VERIFIED
              </div>
              <div>Tier: <strong>{session!.tierName}</strong></div>
              <div>Credentials presented: <strong>{session!.credentials.join(', ')}</strong></div>
              <div>Human key (nullifier): <strong>{session!.humanKeyShort}</strong></div>
              <div className="truncate">Bound wallet: <strong>{session!.wallet}</strong></div>
              <div>Verified: {new Date(session!.verifiedAt * 1000).toLocaleString()}</div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            {!verified && (
              <button
                onClick={() => void world.signIn()}
                disabled={!account || world.phase !== 'idle'}
                className="w-full sm:w-auto bg-[#111111] text-[#FAFAF7] px-6 py-3 text-[12px] font-mono uppercase tracking-[0.14em] border border-[#111111] hover:bg-transparent hover:text-[#111111] transition-all disabled:opacity-50"
              >
                {world.phase === 'idle' ? 'Verify with World ID' : 'Waiting for World App…'}
              </button>
            )}
            {verified && !passport.isLoading && !passport.data && (
              <button
                onClick={() => void mint()}
                disabled={!account || !!busy || world.phase !== 'idle'}
                className="w-full sm:w-auto border border-[#111111] text-[#111111] px-6 py-3 text-[12px] font-mono uppercase tracking-[0.14em] hover:bg-[#111111] hover:text-[#FAFAF7] transition-all disabled:opacity-40"
              >
                Mint Soulbound Credit Passport
              </button>
            )}
          </div>

          {world.error && (
            <div className="mt-6 p-4 border border-red-300 bg-red-50 text-red-900 text-[13px] font-mono flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
              <div>{world.error}</div>
            </div>
          )}

          {passport.data && (
            <div className="mt-6 border border-[#E5E5E0] p-5">
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-4">
                On-chain Credit Passport · registry <ObjLink id={PASSPORT_REGISTRY_ID} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <Stat label="Standing" value={STANDING[passport.data.standing]} sub={`score ${passport.data.score}`} />
                <Stat label="Credit limit" value={`${mist(passport.data.credit_limit_mist)} SUI`} sub={passport.data.active_loan ? 'loan active' : 'no active loan'} />
                <Stat label="History" value={`${passport.data.on_time_repayments} repaid`} sub={`${passport.data.completed_layaways} layaways · ${passport.data.late_marks} late · ${passport.data.defaults} defaults`} />
                <Stat label="Drops" value={`${passport.data.drop_losses} lost`} sub="+1 ticket after a loss" />
              </div>
            </div>
          )}
        </div>

        {verified && <AgentsPanel />}
      </section>
    </div>
  );
}
