'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { useWorldId } from '../world/WorldIdProvider';
import { suiscanTx, useActions } from './actions';
import { useListings, useMyClaims, useNow, countdown, usePlans, useTerms } from '../../lib/hooks';
import { CLAIM_STATUS, mist, toMist, type ClaimJson } from '../../lib/chain';
import {
  borrowTx,
  buyTx,
  completeLayawayTx,
  defaultLayawayTx,
  delistTx,
  listTx,
  payInFullTx,
  payInstallmentTx,
  redeemTx,
  startLayawayTx,
  verifyLivenessTx,
} from '../../lib/tx';
import { Btn, Empty, inputCls, Notice, ObjLink, Panel, SectionHeader } from './ui';

interface Decision {
  approved: boolean;
  reasons: string[];
  max_principal_mist: string;
  fee_bps: number;
  risk_band: number;
  tx_digest?: string;
}

function ClaimCard({ id, c, now }: { id: string; c: ClaimJson; now: number }) {
  const world = useWorldId();
  const { run, busy } = useActions();
  const terms = useTerms(world.session?.humanKey);
  const [ask, setAsk] = useState((mist(c.face_price_mist) * 1.1).toFixed(2));
  const [decision, setDecision] = useState<Decision | null>(null);
  const [uwError, setUwError] = useState('');
  const [uwBusy, setUwBusy] = useState(false);

  const face = BigInt(c.face_price_mist);
  const deposit = BigInt(c.deposit_mist);
  const deadline = Number(c.claim_deadline_ms);

  const verifyLiveness = async () => {
    if (!(await world.verifyLiveness())) return;
    await run('Verify winner liveness', async () => verifyLivenessTx(await world.attest('claim-win', id), id));
  };

  const underwrite = async () => {
    setUwBusy(true);
    setUwError('');
    try {
      const res = await fetch('/api/underwriting/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error);
      setDecision(body);
      await terms.refetch();
    } catch (err) {
      setUwError(err instanceof Error ? err.message : 'underwriting failed');
    } finally {
      setUwBusy(false);
    }
  };

  return (
    <div className="border border-[#E5E5E0] bg-white p-6">
      <div className="flex flex-wrap justify-between gap-2 mb-3">
        <div>
          <div className="text-[11px] font-mono text-[#6B6B6B] uppercase tracking-[0.14em]">Claim <ObjLink id={id} /> · drop <ObjLink id={c.drop_id} /></div>
          <h3 className="font-serif text-xl mt-1">{c.item_name}</h3>
        </div>
        <div className="text-right text-[12px] font-mono">
          <div className="font-bold">{CLAIM_STATUS[c.status]}</div>
          <div className="text-[#6B6B6B]">Face {mist(face)} SUI · deposit held {mist(deposit)} SUI</div>
          {c.status <= 1 && <div className="text-[#6B6B6B]">Claim window: {countdown(deadline, now)}</div>}
        </div>
      </div>

      {c.status === 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Btn onClick={() => void verifyLiveness()} disabled={!!busy || now > deadline}>Confirm it&apos;s me · World ID</Btn>
          <span className="text-[11px] font-mono text-[#6B6B6B]">A fresh World ID session proof: bots that farmed a win can&apos;t claim it.</span>
        </div>
      )}

      {c.status === 1 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Panel title="A · Pay in full">
            <p className="text-[12px] text-[#6B6B6B] mb-3">Pay {mist(face - deposit)} SUI; your deposit covers the rest. Seller is paid {mist(face)} SUI.</p>
            <Btn onClick={() => void run('Pay in full', () => payInFullTx(c.drop_id, id, face - deposit))} disabled={!!busy}>Pay {mist(face - deposit)} SUI</Btn>
          </Panel>
          <Panel title="B · Zero-default layaway">
            <p className="text-[12px] text-[#6B6B6B] mb-3">
              {mist(face / 4n - deposit)} SUI now (25% incl. deposit), then 3 × {mist(face / 4n)} SUI. Miss one and you&apos;re refunded 95% — never in debt. Completing raises your credit limit.
            </p>
            <Btn onClick={() => void run('Start layaway', () => startLayawayTx(c.drop_id, id, face / 4n - deposit))} disabled={!!busy}>Start layaway</Btn>
          </Panel>
          <Panel title="C · Borrow on yourself">
            <p className="text-[12px] text-[#6B6B6B] mb-3">The pool pays the seller {mist(face - deposit)} SUI now; no collateral. Backed by your World ID — repay in 4 installments.</p>
            {terms.data ? (
              <div className="text-[11px] font-mono mb-3 text-emerald-800">
                Approved up to {mist(terms.data.max_principal_mist)} SUI · fee {Number(terms.data.fee_bps) / 100}% · band {terms.data.risk_band}
              </div>
            ) : decision && !decision.approved ? (
              <div className="text-[11px] font-mono mb-3 text-red-800">Declined: {decision.reasons.at(-1)}</div>
            ) : null}
            <div className="flex gap-2">
              <Btn variant="outline" onClick={() => void underwrite()} disabled={uwBusy}>{uwBusy ? 'Underwriting…' : 'Get underwritten'}</Btn>
              <Btn onClick={() => void run('Borrow for claim', () => borrowTx(c.drop_id, id))} disabled={!!busy || !terms.data}>Borrow</Btn>
            </div>
            {uwError && <div className="text-[11px] font-mono text-red-800 mt-2">{uwError}</div>}
            {decision?.approved && (
              <ul className="mt-3 text-[11px] font-mono text-[#6B6B6B] list-disc pl-4 space-y-0.5">
                {decision.reasons.map((r) => <li key={r}>{r}</li>)}
                {decision.tx_digest && <li>Terms written on-chain: <a className="underline text-[#1D3557]" href={suiscanTx(decision.tx_digest)} target="_blank" rel="noreferrer">{decision.tx_digest.slice(0, 10)}…</a></li>}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {c.status === 3 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input className={`${inputCls} w-28`} value={ask} onChange={(e) => setAsk(e.target.value)} />
            <span className="text-[12px] font-mono text-[#6B6B6B]">SUI (cap {(mist(face) * 1.1).toFixed(2)})</span>
            <Btn onClick={() => void run('List for resale', () => listTx(id, toMist(ask)))} disabled={!!busy}>List for resale</Btn>
            <Btn variant="danger" onClick={() => void run('Scalp attempt (111%)', () => listTx(id, (face * 111n) / 100n))} disabled={!!busy}>
              Try to scalp at 111%
            </Btn>
          </div>
          <RedeemForm claimId={id} />
        </div>
      )}
    </div>
  );
}

function RedeemForm({ claimId }: { claimId: string }) {
  const { run, busy } = useActions();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', address1: '', city: '', zip: '', country: 'US', email: '' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const redeem = async () => {
    setError('');
    const res = await fetch('/api/redemptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId, shipping: f }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.message || body.error || 'could not register the address');
    await run('Redeem for delivery', () => redeemTx(claimId));
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Btn variant="outline" onClick={() => setOpen(true)}>Redeem for delivery</Btn>
        <span className="text-[11px] font-mono text-[#6B6B6B]">Burns the claim on Sui and creates a paid order in the merchant&apos;s Shopify store.</span>
      </div>
    );
  }
  return (
    <Panel title="Redeem for delivery · ship to">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        {(['name', 'address1', 'city', 'zip', 'country', 'email'] as const).map((k) => (
          <input key={k} className={inputCls} placeholder={k === 'address1' ? 'street address' : k} value={f[k]} onChange={set(k)} />
        ))}
      </div>
      <div className="flex gap-2">
        <Btn onClick={() => void redeem()} disabled={!!busy || !f.name || !f.address1 || !f.city || !f.zip || !f.country}>Burn claim &amp; order</Btn>
        <Btn variant="outline" onClick={() => setOpen(false)}>Cancel</Btn>
      </div>
      {error && <div className="mt-2 text-[12px] font-mono text-red-800">{error}</div>}
    </Panel>
  );
}

interface RedemptionView {
  claimId: string;
  itemName?: string;
  status: string;
  shipTo: string;
  shopifyOrderName?: string;
  tracking?: string;
  suiTx?: string;
  error?: string;
}

function Deliveries() {
  const world = useWorldId();
  const q = useQuery({
    queryKey: ['redemptions', world.session?.wallet],
    queryFn: async () => (await (await fetch('/api/redemptions')).json()) as { redemptions: RedemptionView[]; shopifyConnected: boolean },
    enabled: !!world.session,
    refetchInterval: 5_000,
  });
  if (!world.session) return <Empty>Verify with World ID to see your deliveries.</Empty>;
  const list = q.data?.redemptions ?? [];
  if (list.length === 0) return <Empty>No redeemed items yet.</Empty>;
  return (
    <div className="space-y-3">
      {!q.data?.shopifyConnected && <Notice tone="warn">The merchant&apos;s Shopify store isn&apos;t connected yet — orders are created as soon as it is.</Notice>}
      {list.map((r) => <Delivery key={r.claimId} r={r} />)}
    </div>
  );
}

const DELIVERY_STATUS: Record<string, string> = {
  awaiting_redeem_tx: 'Address saved — sign the redeem transaction',
  redeemed: 'Claim burned on Sui — creating the Shopify order',
  order_created: 'Order placed with the merchant',
  shipped: 'Shipped',
  order_failed: 'Order creation failed',
};

function Delivery({ r }: { r: RedemptionView }) {
  const t = useQuery({
    queryKey: ['timeline', r.claimId],
    queryFn: async () => (await (await fetch(`/api/ledger/claims/${r.claimId}`)).json()) as { timeline?: { stage: string; at: string; baseTx: string }[] },
    refetchInterval: 10_000,
  });
  return (
    <Panel>
      <div className="flex flex-wrap justify-between gap-2 text-[12px] font-mono">
        <div>
          <span className="font-serif text-lg">{r.itemName ?? 'Claim'}</span> · claim {r.claimId.slice(0, 10)}… · ship to {r.shipTo}
        </div>
        <div className="font-bold">
          {DELIVERY_STATUS[r.status] ?? r.status}
          {r.shopifyOrderName && ` · Shopify ${r.shopifyOrderName}`}
          {r.tracking && ` · tracking ${r.tracking}`}
        </div>
      </div>
      {r.error && <div className="text-[11px] font-mono text-red-800 mt-1">{r.error}</div>}
      {(t.data?.timeline ?? []).length > 0 && (
        <ol className="mt-3 flex flex-wrap gap-2 text-[11px] font-mono">
          {t.data!.timeline!.map((s, i) => (
            <li key={i} className="border border-[#E5E5E0] px-2 py-1">
              {s.stage} ·{' '}
              <a className="underline text-[#1D3557]" href={`https://sepolia.basescan.org/tx/${s.baseTx}`} target="_blank" rel="noreferrer">
                {new Date(s.at).toLocaleTimeString()}
              </a>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export default function ResaleMarketView() {
  const account = useCurrentAccount();
  const world = useWorldId();
  const me = account ? normalizeSuiAddress(account.address) : undefined;
  const claims = useMyClaims(me);
  const plans = usePlans();
  const listings = useListings();
  const { run, busy } = useActions();
  const now = useNow();

  const myPlans = (plans.data ?? []).filter((p) => p.json.buyer === me && p.json.status === 0);
  const overdue = (plans.data ?? []).filter((p) => p.json.status === 0 && p.json.installments_paid < 4 && Number(p.json.next_due_ms) < now);

  const buy = async (claimId: string, price: bigint) => {
    if ((!world.session || world.walletMismatch) && !(await world.signIn())) return;
    await run('Buy resale claim', async () => buyTx(await world.attest('buy-resale', claimId), claimId, price));
  };

  return (
    <div className="animate-fade-in space-y-10 pb-24 py-12">
      <SectionHeader kicker="§ 03 — CLAIMS, SETTLEMENT & FAIR RESALE" title="Win, prove it's you, then settle">
        Winning claims are key-only Sui objects: they can&apos;t be sent to a scalper. Settle by paying in full, layaway, or an
        uncollateralized loan — then resell at no more than 110% of face value.
      </SectionHeader>

      <section className="space-y-4">
        <h3 className="font-serif text-2xl">My claims</h3>
        {!account ? <Empty>Connect your wallet.</Empty> : claims.isLoading ? <Empty>Loading…</Empty> : claims.error ? <Notice tone="warn">Could not load claims: {String(claims.error)}</Notice> : (claims.data ?? []).length === 0 ? <Empty>No claims in this wallet. Win a drop first.</Empty> : claims.data!.map((c) => <ClaimCard key={c.id} id={c.id} c={c.json} now={now} />)}
      </section>

      <section className="space-y-4">
        <h3 className="font-serif text-2xl">My deliveries</h3>
        <p className="text-[13px] text-[#6B6B6B] max-w-[760px]">Each step is recorded on the Scalpless RWA ledger on Base Sepolia through Curvegrid MultiBaas.</p>
        <Deliveries />
      </section>

      <section className="space-y-4">
        <h3 className="font-serif text-2xl">My layaway plans</h3>
        {myPlans.length === 0 ? <Empty>No active layaway plans.</Empty> : myPlans.map((p) => {
          const due = p.json.installments_paid === 3 ? BigInt(p.json.total_mist) - BigInt(p.json.paid_mist) : BigInt(p.json.installment_mist);
          const paidOff = p.json.paid_mist === p.json.total_mist;
          return (
            <Panel key={p.id}>
              <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] font-mono">
                <div>
                  Plan <ObjLink id={p.id} /> · claim <ObjLink id={p.json.claim_id} /> · {p.json.installments_paid}/4 paid ({mist(p.json.paid_mist)} / {mist(p.json.total_mist)} SUI)
                  {!paidOff && <span className="ml-2 text-[#6B6B6B]">next due in {countdown(Number(p.json.next_due_ms), now)}</span>}
                </div>
                {paidOff ? (
                  <Btn onClick={() => void run('Complete layaway', () => completeLayawayTx(p.id, p.json.claim_id))} disabled={!!busy}>Collect claim</Btn>
                ) : (
                  <Btn onClick={() => void run('Pay installment', () => payInstallmentTx(p.id, due))} disabled={!!busy || Number(p.json.next_due_ms) < now}>Pay {mist(due)} SUI</Btn>
                )}
              </div>
            </Panel>
          );
        })}
      </section>

      <section className="space-y-4">
        <h3 className="font-serif text-2xl">Resale market</h3>
        <p className="text-[13px] text-[#6B6B6B] max-w-[760px]">Listed claims are held by the market object. Buyers must be verified humans, one resale per human per drop; proceeds repay the seller&apos;s loan first.</p>
        {listings.error ? <Notice tone="warn">Could not load listings: {String(listings.error)}</Notice> : (listings.data ?? []).length === 0 ? <Empty>No listings.</Empty> : listings.data!.map((l) => {
          const mine = l.listing.seller === me;
          return (
            <Panel key={l.id}>
              <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] font-mono">
                <div>
                  <span className="font-serif text-lg">{l.json.item_name}</span> · claim <ObjLink id={l.id} /> · face {mist(l.listing.face_price_mist)} SUI · ask{' '}
                  <strong>{mist(l.listing.ask_mist)} SUI</strong> · seller <ObjLink id={l.listing.seller} />
                </div>
                {mine ? (
                  <Btn variant="outline" onClick={() => void run('Delist', () => delistTx(l.id))} disabled={!!busy}>Delist</Btn>
                ) : (
                  <Btn onClick={() => void buy(l.id, BigInt(l.listing.ask_mist))} disabled={!account || !!busy}>Buy · {mist(l.listing.ask_mist)} SUI</Btn>
                )}
              </div>
            </Panel>
          );
        })}
      </section>

      <section className="space-y-4">
        <h3 className="font-serif text-2xl">Keeper: overdue layaways</h3>
        <p className="text-[13px] text-[#6B6B6B] max-w-[760px]">Anyone can default an overdue plan: the buyer is refunded 95% and the claim passes to the next human on the drop&apos;s waitlist.</p>
        {overdue.length === 0 ? <Empty>Nothing overdue.</Empty> : overdue.map((p) => (
          <Panel key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] font-mono">
              <div>Plan <ObjLink id={p.id} /> · buyer <ObjLink id={p.json.buyer} /> · {p.json.installments_paid}/4 paid · was due {new Date(Number(p.json.next_due_ms)).toLocaleTimeString()}</div>
              <Btn variant="danger" onClick={() => void run('Default layaway', () => defaultLayawayTx(p.id, p.json.drop_id, p.json.claim_id))} disabled={!account || !!busy}>Default → waitlist</Btn>
            </div>
          </Panel>
        ))}
      </section>
      {!world.session && <Notice>Verify with World ID to claim wins and buy resales.</Notice>}
    </div>
  );
}
