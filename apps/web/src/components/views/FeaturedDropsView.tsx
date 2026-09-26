'use client';

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useWorldId } from '../world/WorldIdProvider';
import { useActions } from './actions';
import { useDrops, useNow, countdown, usePassport } from '../../lib/hooks';
import { b64ToHex, mist, toMist, type DropJson } from '../../lib/chain';
import { createDropTx, enterDropTx, executeDrawTx } from '../../lib/tx';
import { Btn, Empty, Field, inputCls, Notice, ObjLink, Panel, SectionHeader } from './ui';

const TIER_LABEL = ['Any verified human', 'Tier 1+ (selfie)', 'Tier 2+ (passport)', 'Tier 3 (Orb only)'];

function CreateDrop() {
  const account = useCurrentAccount();
  const { run, busy } = useActions();
  const [f, setF] = useState({ title: 'Sony PlayStation 5 — 30th Anniversary', price: '1', units: '1', tier: '0', entry: '3', claim: '20', interval: '2' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const create = () =>
    run('Create drop', () =>
      createDropTx({
        title: f.title,
        facePriceMist: toMist(f.price),
        units: Number(f.units),
        minTier: Number(f.tier),
        entryDeadlineMs: Date.now() + Number(f.entry) * 60_000,
        claimWindowMs: Number(f.claim) * 60_000,
        installmentIntervalMs: Number(f.interval) * 60_000,
      }),
    );

  return (
    <Panel title="Launch a drop (you are the seller)">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div className="md:col-span-2"><Field label="Item"><input className={inputCls} value={f.title} onChange={set('title')} /></Field></div>
        <Field label="Face price (SUI)"><input className={inputCls} value={f.price} onChange={set('price')} /></Field>
        <Field label="Units"><input className={inputCls} value={f.units} onChange={set('units')} /></Field>
        <Field label="Who may enter">
          <select className={inputCls} value={f.tier} onChange={set('tier')}>
            {TIER_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </Field>
        <Field label="Entries close in (min)"><input className={inputCls} value={f.entry} onChange={set('entry')} /></Field>
        <Field label="Claim window (min)"><input className={inputCls} value={f.claim} onChange={set('claim')} /></Field>
        <Field label="Layaway interval (min)"><input className={inputCls} value={f.interval} onChange={set('interval')} /></Field>
      </div>
      <Btn onClick={create} disabled={!account || !!busy}>Create drop on Sui</Btn>
      <span className="ml-3 text-[11px] font-mono text-[#6B6B6B]">Short timings make the full lifecycle demoable in minutes.</span>
    </Panel>
  );
}

function DropCard({ id, d, now }: { id: string; d: DropJson; now: number }) {
  const account = useCurrentAccount();
  const world = useWorldId();
  const passport = usePassport(world.session?.humanKey);
  const { run, busy } = useActions();
  const deadline = Number(d.entry_deadline_ms);
  const open = d.status === 0;
  const myEntry = world.session && d.entries.find((e) => b64ToHex(e.human_key) === world.session!.humanKey);
  const winners = d.entries.filter((e) => e.round_won > 0);

  const enter = async () => {
    if ((!world.session || world.walletMismatch) && !(await world.signIn())) return;
    await run('Enter drop', async () => enterDropTx(await world.attest('enter-drop', id), id, BigInt(d.deposit_mist)));
  };

  return (
    <div className="border border-[#E5E5E0] bg-white">
      <div className="p-6 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-mono text-[#6B6B6B] uppercase tracking-[0.14em]">
            Drop <ObjLink id={id} /> · seller <ObjLink id={d.seller} />
          </div>
          <h3 className="font-serif text-2xl mt-1">{d.title}</h3>
          <div className="text-[12px] font-mono text-[#6B6B6B] mt-1">
            {d.total_units} unit(s) · {TIER_LABEL[d.min_tier]} · {d.entries.length} human(s) entered
          </div>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <div className="text-[11px] font-mono text-[#6B6B6B] uppercase">Face price</div>
            <div className="font-serif text-xl">{mist(d.face_price_mist)} SUI</div>
          </div>
          <div>
            <div className="text-[11px] font-mono text-[#6B6B6B] uppercase">Deposit (10%)</div>
            <div className="font-serif text-xl text-[#1D3557]">{mist(d.deposit_mist)} SUI</div>
          </div>
        </div>
      </div>
      <div className="px-6 py-4 bg-[#FAFAF7] border-t border-[#E5E5E0] flex flex-wrap items-center justify-between gap-3 text-[12px] font-mono">
        <div>
          {open && now < deadline && <span className="text-emerald-800 font-bold">OPEN · closes in {countdown(deadline, now)}</span>}
          {open && now >= deadline && <span className="text-amber-800 font-bold">ENTRIES CLOSED · ready to draw</span>}
          {!open && (
            <span>
              <span className="font-bold">DRAWN</span> · {winners.length} winner(s) · {d.waitlist.length} on waitlist · losers refunded
            </span>
          )}
          {myEntry && <span className="ml-3 text-[#1D3557]">You entered · {myEntry.tickets} tickets{!open && (myEntry.round_won > 0 ? ` · WON round ${myEntry.round_won}` : ' · not drawn')}</span>}
        </div>
        <div className="flex gap-2">
          {open && now < deadline && !myEntry && (
            <Btn onClick={() => void enter()} disabled={!account || !!busy || !passport.data}>
              Enter · lock {mist(d.deposit_mist)} SUI
            </Btn>
          )}
          {open && now >= deadline && (
            <Btn variant="outline" onClick={() => void run('Run sui::random draw', () => executeDrawTx(id))} disabled={!account || !!busy}>
              Run 3-round draw
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FeaturedDropsView() {
  const drops = useDrops();
  const world = useWorldId();
  const passport = usePassport(world.session?.humanKey);
  const now = useNow();
  const sorted = [...(drops.data ?? [])].sort((a, b) => Number(b.json.entry_deadline_ms) - Number(a.json.entry_deadline_ms));

  return (
    <div className="animate-fade-in space-y-8 pb-24 py-12">
      <SectionHeader kicker="§ 02 — FAIR DROPS · ONE HUMAN, ONE ENTRY" title="Weighted three-round draw on Sui">
        Enter with a World ID attestation and a refundable 10% deposit. The draw uses Sui&apos;s on-chain randomness: round I is open
        to everyone, round II to passport/Orb holders, round III to Orb holders. Losers are refunded in the draw transaction and join a
        random-order waitlist.
      </SectionHeader>
      {world.session && !passport.isLoading && !passport.data && (
        <Notice tone="warn">Mint your Credit Passport on the World ID page before entering drops.</Notice>
      )}
      <CreateDrop />
      {drops.isLoading ? <Empty>Loading drops from Sui…</Empty> : sorted.length === 0 ? <Empty>No drops yet — launch one above.</Empty> : sorted.map((x) => <DropCard key={x.id} id={x.id} d={x.json} now={now} />)}
      {drops.error && <Notice tone="warn">Could not load drops: {String(drops.error)}</Notice>}
    </div>
  );
}
