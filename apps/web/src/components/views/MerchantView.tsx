'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { useDrops } from '../../lib/hooks';
import { mist, toMist } from '../../lib/chain';
import { createDropTx } from '../../lib/tx';
import { signAndExecute } from '../../lib/dapp-kit';
import { explainError, suiscanTx } from './actions';
import { useWorldId } from '../world/WorldIdProvider';
import { Btn, Empty, Field, inputCls, Notice, ObjLink, Panel, SectionHeader, Stat } from './ui';

interface LedgerStatus {
  ledger: string | null;
  explorer: string | null;
  processed: number;
  lastRunAt: string | null;
  lastError: string | null;
}
interface LedgerDrop {
  dropId: string;
  title: string;
  shopifyVariant: string;
  units: number;
  claims: number;
  byStage: Record<string, number>;
}

const getJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || body.error);
  return body as T;
};

interface ShopifyProduct {
  id: string;
  title: string;
  image: string | null;
  url: string | null;
  variants: { id: string; title: string; price: string; inventory: number | null }[];
}

function ShopifyLaunch() {
  const world = useWorldId();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['shopify-status'], queryFn: () => getJson<{ connected: boolean; shop?: { name: string; myshopifyDomain: string; currencyCode: string }; error?: string }>('/api/shopify/status') });
  const products = useQuery({ queryKey: ['shopify-products'], queryFn: () => getJson<{ products: ShopifyProduct[] }>('/api/shopify/products'), enabled: !!status.data?.connected && !!world.session });
  const [pick, setPick] = useState<{ product: ShopifyProduct; variantId: string } | null>(null);
  const [f, setF] = useState({ price: '0.5', units: '1', entry: '3', claim: '20', interval: '2' });
  const [msg, setMsg] = useState<{ ok?: string; digest?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!status.data?.connected) {
    return <Notice tone="warn">Shopify store not connected{status.data?.error ? `: ${status.data.error}` : ' — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN'}.</Notice>;
  }

  const launch = async () => {
    if (!pick) return;
    setBusy(true);
    setMsg(null);
    try {
      const variant = pick.product.variants.find((v) => v.id === pick.variantId)!;
      const t = await signAndExecute(
        createDropTx({
          title: `${pick.product.title}${variant.title !== 'Default Title' ? ` — ${variant.title}` : ''}`,
          facePriceMist: toMist(f.price),
          units: Number(f.units),
          minTier: 0,
          entryDeadlineMs: Date.now() + Number(f.entry) * 60_000,
          claimWindowMs: Number(f.claim) * 60_000,
          installmentIntervalMs: Number(f.interval) * 60_000,
        }),
      );
      const dropId = t.effects.changedObjects.find((o) => o.idOperation === 'Created' && o.outputOwner?.$kind === 'Shared')?.objectId;
      if (!dropId) throw new Error('drop created but its id was not found in the effects');
      const res = await fetch('/api/shopify/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dropId, productId: pick.product.id, variantId: pick.variantId }) });
      const body = await res.json();
      if (!res.ok) throw new Error(`drop ${dropId} created, but linking failed: ${body.message || body.error}`);
      setMsg({ ok: `Drop live and linked to ${pick.product.title}. The product page now links to it.`, digest: t.digest });
      setPick(null);
      await queryClient.invalidateQueries();
    } catch (err) {
      setMsg({ error: explainError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={`Shopify · ${status.data.shop?.name} (${status.data.shop?.myshopifyDomain})`}>
      {!world.session ? (
        <Empty>Verify with World ID to manage drops.</Empty>
      ) : products.isLoading ? (
        <Empty>Loading products…</Empty>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(products.data?.products ?? []).map((p) => (
            <div key={p.id} className={`border p-3 ${pick?.product.id === p.id ? 'border-[#111111]' : 'border-[#E5E5E0]'}`}>
              {p.image && <img src={p.image} alt={p.title} className="w-full h-32 object-cover mb-2" />}
              <div className="font-serif text-lg">{p.title}</div>
              {p.variants.map((v) => (
                <button key={v.id} onClick={() => setPick({ product: p, variantId: v.id })} className={`block w-full text-left text-[12px] font-mono mt-1 px-2 py-1 border ${pick?.variantId === v.id ? 'border-[#111111] bg-[#111111]/5' : 'border-transparent hover:border-[#E5E5E0]'}`}>
                  {v.title} · {v.price} {status.data!.shop?.currencyCode} · stock {v.inventory ?? '—'}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {pick && (
        <div className="mt-6 border-t border-[#E5E5E0] pt-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            <Field label="Face price (SUI)"><input className={inputCls} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="Units"><input className={inputCls} value={f.units} onChange={(e) => setF({ ...f, units: e.target.value })} /></Field>
            <Field label="Entries close (min)"><input className={inputCls} value={f.entry} onChange={(e) => setF({ ...f, entry: e.target.value })} /></Field>
            <Field label="Claim window (min)"><input className={inputCls} value={f.claim} onChange={(e) => setF({ ...f, claim: e.target.value })} /></Field>
            <Field label="Layaway interval (min)"><input className={inputCls} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} /></Field>
          </div>
          <Btn onClick={() => void launch()} disabled={busy}>{busy ? 'Launching…' : `Launch fair drop of ${pick.product.title}`}</Btn>
        </div>
      )}
      {msg?.ok && <div className="mt-3 text-[12px] font-mono text-emerald-800">✓ {msg.ok} {msg.digest && <a className="underline" href={suiscanTx(msg.digest)} target="_blank" rel="noreferrer">tx</a>}</div>}
      {msg?.error && <div className="mt-3 text-[12px] font-mono text-red-800">✕ {msg.error}</div>}
    </Panel>
  );
}

export default function MerchantView() {
  const account = useCurrentAccount();
  const me = account ? normalizeSuiAddress(account.address) : undefined;
  const drops = useDrops();
  const status = useQuery({ queryKey: ['ledger-status'], queryFn: () => getJson<LedgerStatus>('/api/ledger/status'), refetchInterval: 10_000 });
  const ledger = useQuery({ queryKey: ['ledger-drops'], queryFn: () => getJson<{ drops: LedgerDrop[] }>('/api/ledger/drops'), refetchInterval: 15_000, enabled: !!status.data?.ledger });

  const mine = (drops.data ?? []).filter((d) => d.json.seller === me);

  return (
    <div className="animate-fade-in space-y-8 pb-24 py-12">
      <SectionHeader kicker="§ 06 — MERCHANT · RWA LEDGER (CURVEGRID MULTIBAAS)" title="Every unit, from drop to doorstep">
        Each claim is a tokenized right to one unit of your inventory. Its whole lifecycle — won, paid, financed, resold, redeemed,
        shipped — is recorded on the Scalpless RWA ledger on Base Sepolia through Curvegrid MultiBaas, which indexes it for this
        dashboard.
      </SectionHeader>

      <Panel title="RWA ledger">
        {!status.data?.ledger ? (
          <Notice tone="warn">Ledger not deployed yet (pnpm deploy:ledger).</Notice>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <Stat label="Ledger (Base Sepolia)" value={<a className="underline text-[#1D3557] text-base" href={status.data.explorer!} target="_blank" rel="noreferrer">{status.data.ledger.slice(0, 10)}…</a>} sub="managed in MultiBaas" />
            <Stat label="Sui events mirrored" value={status.data.processed} />
            <Stat label="Last sync" value={status.data.lastRunAt ? new Date(status.data.lastRunAt).toLocaleTimeString() : '—'} />
            <Stat label="Mirror" value={status.data.lastError ? 'Retrying' : 'Healthy'} sub={status.data.lastError?.slice(0, 80)} />
          </div>
        )}
      </Panel>

      <ShopifyLaunch />

      <section className="space-y-4">
        <h3 className="font-serif text-2xl">My drops</h3>
        {!account ? <Empty>Connect the seller wallet.</Empty> : mine.length === 0 ? <Empty>You haven&apos;t launched a drop from this wallet.</Empty> : mine.map((d) => {
          const l = ledger.data?.drops.find((x) => x.dropId.toLowerCase() === d.id.toLowerCase());
          const winners = d.json.entries.filter((e) => e.round_won > 0).length;
          return (
            <Panel key={d.id}>
              <div className="flex flex-wrap justify-between gap-2 mb-4">
                <div>
                  <div className="text-[11px] font-mono text-[#6B6B6B] uppercase tracking-[0.14em]">Drop <ObjLink id={d.id} /></div>
                  <h4 className="font-serif text-xl">{d.json.title}</h4>
                  <div className="text-[12px] font-mono text-[#6B6B6B]">{l?.shopifyVariant ? `Shopify ${l.shopifyVariant}` : 'Not linked to a Shopify product'}</div>
                </div>
                <div className="text-right font-mono text-[12px]">
                  <div>{d.json.total_units} unit(s) · {mist(d.json.face_price_mist)} SUI</div>
                  <div className="text-[#6B6B6B]">{d.json.status === 0 ? 'Open' : 'Drawn'}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <Stat label="Verified humans entered" value={d.json.entries.length} />
                <Stat label="Winners" value={winners} sub={`${d.json.waitlist.length} on waitlist`} />
                <Stat label="Claims on ledger" value={l?.claims ?? '—'} />
                <Stat label="By stage" value={<span className="text-sm font-mono">{l ? Object.entries(l.byStage).map(([k, v]) => `${k} ${v}`).join(' · ') || '—' : '—'}</span>} />
              </div>
            </Panel>
          );
        })}
      </section>
    </div>
  );
}
