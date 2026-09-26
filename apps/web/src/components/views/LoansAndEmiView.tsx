'use client';

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { useWorldId } from '../world/WorldIdProvider';
import { useActions } from './actions';
import { useBalances, useLoans, useNow, countdown, usePool } from '../../lib/hooks';
import { amountOwed, mist, toMist, type LoanJson, type PoolJson } from '../../lib/chain';
import { depositTx, markTx, repayTx, withdrawTx } from '../../lib/tx';
import { LENDING_POOL_OBJECT_ID } from '../../lib/constants';
import { Btn, Empty, inputCls, ObjLink, Panel, SectionHeader, Stat } from './ui';

const supply = (p: PoolJson, t: 'senior' | 'junior') => BigInt(p[`${t}_cap`].total_supply.value);
const sharePrice = (assets: bigint, shares: bigint) => (shares === 0n ? 1 : Number(assets) / Number(shares));

/** Installment schedule + when mark_late / mark_default become possible. */
function schedule(l: LoanJson, p: PoolJson, now: number) {
  const start = Number(l.started_ms);
  const term = Number(p.term_ms);
  const grace = Number(p.grace_ms);
  const interval = term / 4;
  const dueCount = Math.min(4, Math.floor((now - start) / interval));
  const paid = BigInt(l.repaid_principal_mist) + BigInt(l.repaid_fee_mist);
  const expected = BigInt(dueCount) * BigInt(l.installment_mist);
  const total = BigInt(l.principal_mist) + BigInt(l.fee_mist);
  const behind = paid < (expected < total ? expected : total);
  const lateAt = start + dueCount * interval + grace;
  const defaultAt = start + term + grace;
  const nextDue = start + Math.min(4, dueCount + 1) * interval;
  return { behind, lateAt, defaultAt, nextDue, canLate: behind && !l.late_marked && now >= lateAt, canDefault: now >= defaultAt };
}

function Tranche({ t, pool, lp }: { t: 'senior' | 'junior'; pool: PoolJson; lp: bigint }) {
  const account = useCurrentAccount();
  const { run, busy } = useActions();
  const [amount, setAmount] = useState('1');
  const assets = BigInt(pool[`${t}_assets`]);
  const shares = supply(pool, t);
  const price = sharePrice(assets, shares);
  const me = account ? normalizeSuiAddress(account.address) : '';
  return (
    <Panel title={t === 'senior' ? '01 / Senior tranche · protected' : '02 / Junior tranche · first loss'}>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Stat label="Tranche assets" value={`${mist(assets).toFixed(3)} SUI`} sub={`${mist(shares).toFixed(3)} ${t === 'senior' ? 'sSCALP' : 'jSCALP'} supply`} />
        <Stat label="Share price" value={`${price.toFixed(4)} SUI`} sub={t === 'senior' ? `${Number(pool.senior_fee_share_bps) / 100}% of loan fees` : `${100 - Number(pool.senior_fee_share_bps) / 100}% of fees · absorbs defaults first`} />
      </div>
      <div className="text-[12px] font-mono mb-3">
        You hold {mist(lp).toFixed(3)} {t === 'senior' ? 'sSCALP' : 'jSCALP'} ≈ {(mist(lp) * price).toFixed(3)} SUI
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} w-24`} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Btn onClick={() => void run(`Deposit ${t}`, () => depositTx(t, toMist(amount), me))} disabled={!account || !!busy}>Deposit SUI</Btn>
        <Btn variant="outline" onClick={() => void run(`Withdraw ${t}`, () => withdrawTx(t, lp, me))} disabled={!account || !!busy || lp === 0n}>Withdraw all</Btn>
      </div>
    </Panel>
  );
}

export default function LoansAndEmiView() {
  const account = useCurrentAccount();
  const me = account ? normalizeSuiAddress(account.address) : undefined;
  const world = useWorldId();
  const pool = usePool();
  const loans = useLoans();
  const balances = useBalances(me);
  const { run, busy } = useActions();
  const now = useNow();

  if (!pool.data) return <div className="py-24"><Empty>{pool.isLoading ? 'Loading the lending pool from Sui…' : 'Lending pool not found.'}</Empty></div>;
  const p = pool.data;
  const myLoan = world.session && loans.data?.find((l) => l.humanKey === world.session!.humanKey);

  return (
    <div className="animate-fade-in space-y-10 pb-24 py-12">
      <SectionHeader kicker="§ 05 — HUMAN-BACKED LENDING (SUI DEFI)" title="Borrow on yourself; lend by tranche">
        Loans need no collateral: the borrower&apos;s World ID is the security. A default locks that human out of Scalpless on every
        wallet, the junior tranche absorbs the loss first, and anyone can enforce the schedule on-chain.
      </SectionHeader>

      <Panel title={`Pool · ${LENDING_POOL_OBJECT_ID.slice(0, 10)}…`}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
          <Stat label="Available cash" value={`${mist(p.cash).toFixed(3)} SUI`} />
          <Stat label="Lent out" value={`${mist(p.outstanding_principal).toFixed(3)} SUI`} sub={`${p.loans.size} active loan(s)`} />
          <Stat label="Losses absorbed" value={`${mist(p.total_losses).toFixed(3)} SUI`} />
          <Stat label="Loan term" value={`${Number(p.term_ms) / 60_000} min`} sub={`4 installments · ${Number(p.grace_ms) / 60_000} min grace`} />
          <Stat label="Pool object" value={<ObjLink id={LENDING_POOL_OBJECT_ID} />} />
        </div>
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Tranche t="senior" pool={p} lp={balances.data?.senior ?? 0n} />
        <Tranche t="junior" pool={p} lp={balances.data?.junior ?? 0n} />
      </div>

      <Panel title="My loan">
        {!world.session ? (
          <Empty>Verify with World ID to see your loan.</Empty>
        ) : !myLoan ? (
          <Empty>No active loan. Borrow against a won claim on the Claims page.</Empty>
        ) : (() => {
          const s = schedule(myLoan.loan, p, now);
          const owed = amountOwed(myLoan.loan);
          const inst = BigInt(myLoan.loan.installment_mist);
          const next = inst < owed ? inst : owed;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <Stat label="Owed" value={`${mist(owed).toFixed(4)} SUI`} sub={`principal ${mist(myLoan.loan.principal_mist)} + fee ${mist(myLoan.loan.fee_mist)}`} />
                <Stat label="Installment" value={`${mist(inst).toFixed(4)} SUI`} />
                <Stat label="Next due" value={countdown(s.nextDue, now)} sub={s.behind ? 'BEHIND SCHEDULE' : 'on track'} />
                <Stat label="Default possible in" value={countdown(s.defaultAt, now)} />
              </div>
              <div className="flex gap-2">
                <Btn onClick={() => void run('Repay installment', () => repayTx(myLoan.humanKey, next, me!))} disabled={!!busy}>Pay {mist(next).toFixed(4)} SUI</Btn>
                <Btn variant="outline" onClick={() => void run('Repay in full', () => repayTx(myLoan.humanKey, owed, me!))} disabled={!!busy}>Repay all</Btn>
              </div>
            </div>
          );
        })()}
      </Panel>

      <Panel title="Keeper · enforce the schedule (anyone can)">
        {(loans.data ?? []).length === 0 ? (
          <Empty>No active loans.</Empty>
        ) : (
          <div className="divide-y divide-[#E5E5E0]">
            {loans.data!.map(({ humanKey, loan }) => {
              const s = schedule(loan, p, now);
              return (
                <div key={humanKey} className="py-3 flex flex-wrap items-center justify-between gap-3 text-[12px] font-mono">
                  <div>
                    Human {humanKey.slice(0, 8)}… · borrower <ObjLink id={loan.borrower} /> · owes {mist(amountOwed(loan)).toFixed(4)} SUI
                    {loan.late_marked && <span className="ml-2 text-amber-800">LATE</span>}
                    {!s.canDefault && <span className="ml-2 text-[#6B6B6B]">default possible in {countdown(s.defaultAt, now)}</span>}
                  </div>
                  <div className="flex gap-2">
                    <Btn variant="outline" onClick={() => void run('Mark late', () => markTx('mark_late', humanKey))} disabled={!account || !!busy || !s.canLate}>Mark late</Btn>
                    <Btn variant="danger" onClick={() => void run('Mark default', () => markTx('mark_default', humanKey))} disabled={!account || !!busy || !s.canDefault}>Mark default</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
