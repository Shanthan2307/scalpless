// Shopify: the merchant's store (Admin GraphQL API, custom-app access token).
//  * products → the merchant picks one to launch as a drop
//  * link     → the product page gets an "Enter the fair drop" link + tag; the ledger records the variant
//  * orders   → a redeemed claim becomes a paid order for that variant
//  * polling  → a fulfilled order marks the delivery shipped (Scalpless + ledger) — no webhooks needed
import { ledgerCall } from './multibaas.service';
import { mirrorState } from './mirror.service';
import { getShopifyLink, setShopifyLink } from './shopify-links';
import { redemptions, setOrderCreator, type Redemption } from './redemption.service';
import { objectJson } from './chain.service';

const VERSION = process.env.SHOPIFY_API_VERSION?.trim() || '2025-10';
const POLL_MS = 30_000;

const domain = () => process.env.SHOPIFY_STORE_DOMAIN!.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');

// Either a static custom-app token, or a Dev Dashboard app's client id/secret exchanged for a
// short-lived Admin API token (client credentials grant), refreshed before it expires.
export const shopifyConfigured = () =>
  !!process.env.SHOPIFY_STORE_DOMAIN?.trim() &&
  (!!process.env.SHOPIFY_ADMIN_TOKEN?.trim() || !!(process.env.SHOPIFY_CLIENT_ID?.trim() && process.env.SHOPIFY_CLIENT_SECRET?.trim()));

let token: { value: string; expiresAt: number } | null = null;
async function accessToken(): Promise<string> {
  const fixed = process.env.SHOPIFY_ADMIN_TOKEN?.trim();
  if (fixed) return fixed;
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://${domain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SHOPIFY_CLIENT_ID!.trim(), client_secret: process.env.SHOPIFY_CLIENT_SECRET!.trim() }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify token: ${/<title>([^<]*)<\/title>/.exec(text)?.[1] ?? text.slice(0, 200)}`);
  const body = JSON.parse(text) as { access_token: string; expires_in?: number };
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function admin<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${domain()}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': await accessToken() },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || body.errors) throw new Error(`Shopify: ${JSON.stringify(body.errors ?? res.status).slice(0, 300)}`);
  return body.data as T;
}

function userErrors(errs: { field?: string[]; message: string }[] | undefined) {
  if (errs?.length) throw new Error(`Shopify: ${errs.map((e) => e.message).join('; ')}`);
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  image: string | null;
  url: string | null;
  variants: { id: string; title: string; price: string; inventory: number | null }[];
}

export async function shopInfo() {
  const d = await admin<{ shop: { name: string; myshopifyDomain: string; currencyCode: string } }>(`{ shop { name myshopifyDomain currencyCode } }`);
  return d.shop;
}

export async function listProducts(): Promise<ShopifyProduct[]> {
  const d = await admin<{ products: { nodes: any[] } }>(`{
    products(first: 25, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id title handle onlineStorePreviewUrl
        featuredMedia { preview { image { url } } }
        variants(first: 10) { nodes { id title price inventoryQuantity } }
      }
    }
  }`);
  return d.products.nodes.map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    image: p.featuredMedia?.preview?.image?.url ?? null,
    url: p.onlineStorePreviewUrl ?? null,
    variants: p.variants.nodes.map((v: any) => ({ id: v.id, title: v.title, price: v.price, inventory: v.inventoryQuantity ?? null })),
  }));
}

/** After the Sui drop exists: record the variant on the ledger and point the product page at the drop. */
export async function linkDrop(p: { dropId: string; productId: string; variantId: string; appUrl: string }) {
  setShopifyLink(p.dropId, { productId: p.productId, variantId: p.variantId });

  // The GraphQL indexer can trail a just-executed create_drop by a few seconds.
  let drop: { title: string; face_price_mist: string; total_units: string } | null = null;
  for (let i = 0; i < 10 && !drop; i++) {
    drop = await objectJson(p.dropId);
    if (!drop) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!drop) throw new Error('drop not found on Sui');
  if (process.env.RWA_LEDGER_ADDRESS) {
    await ledgerCall('listDrop', [`0x${p.dropId.replace(/^0x/, '').padStart(64, '0')}`, drop.title, p.variantId, drop.face_price_mist, drop.total_units, `0x${'00'.repeat(32)}`]);
  }

  const cur = await admin<{ product: { descriptionHtml: string } }>(`query($id: ID!) { product(id: $id) { descriptionHtml } }`, { id: p.productId });
  const link = `<p data-scalpless="${p.dropId}"><strong>Bots can't buy this.</strong> One verified human, one fair chance: <a href="${p.appUrl}?drop=${p.dropId}">Enter the fair drop on Scalpless →</a></p>`;
  const description = cur.product.descriptionHtml.replace(/<p data-scalpless="[^"]*">[\s\S]*?<\/p>/g, '') + link;
  const upd = await admin<{ productUpdate: { userErrors: any[] } }>(
    `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
    { product: { id: p.productId, descriptionHtml: description } },
  );
  userErrors(upd.productUpdate.userErrors);
  const tag = await admin<{ tagsAdd: { userErrors: any[] } }>(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, {
    id: p.productId,
    tags: ['scalpless-drop'],
  });
  userErrors(tag.tagsAdd.userErrors);
}

async function variantPrice(variantId: string) {
  const d = await admin<{ productVariant: { price: string } | null; shop: { currencyCode: string } }>(
    `query($id: ID!) { productVariant(id: $id) { price } shop { currencyCode } }`,
    { id: variantId },
  );
  if (!d.productVariant) throw new Error(`variant ${variantId} not found`);
  return { amount: d.productVariant.price, currency: d.shop.currencyCode };
}

/** A redeemed claim → a paid order for the drop's variant, shipped to the holder. */
async function createOrder(r: Redemption): Promise<{ id: string; name: string }> {
  const claimDrop = mirrorState().claimDrop[r.claimId] ?? Object.entries(mirrorState().claimDrop).find(([k]) => k.toLowerCase() === r.claimId.toLowerCase())?.[1];
  const variantId = claimDrop && getShopifyLink(claimDrop)?.variantId;
  if (!variantId) throw new Error('this drop is not linked to a Shopify product');
  const price = await variantPrice(variantId);
  const [firstName, ...rest] = r.shipping.name.trim().split(/\s+/);
  const d = await admin<{ orderCreate: { order: { id: string; name: string } | null; userErrors: any[] } }>(
    `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } }
    }`,
    {
      order: {
        lineItems: [{ variantId, quantity: 1 }],
        email: r.shipping.email || undefined,
        shippingAddress: { firstName, lastName: rest.join(' ') || firstName, address1: r.shipping.address1, city: r.shipping.city, zip: r.shipping.zip, countryCode: r.shipping.country.toUpperCase() },
        financialStatus: 'PAID',
        transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'Scalpless (Sui)', amountSet: { shopMoney: { amount: price.amount, currencyCode: price.currency } } }],
        note: `Scalpless claim ${r.claimId} redeemed on Sui (tx ${r.suiTx}). Paid on-chain; World ID-verified buyer.`,
        tags: ['scalpless', 'rwa-redemption'],
      },
      options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false },
    },
  );
  userErrors(d.orderCreate.userErrors);
  return d.orderCreate.order!;
}

/** Create orders that were waiting for the store, and pick up fulfillments. */
export async function syncShopify() {
  for (const r of redemptions.all()) {
    try {
      if (r.status === 'redeemed' || r.status === 'order_failed') {
        const order = await createOrder(r);
        redemptions.update(r.claimId, { status: 'order_created', shopifyOrder: order.id, shopifyOrderName: order.name, error: undefined });
        if (process.env.RWA_LEDGER_ADDRESS) await ledgerCall('recordRedeemed', [r.claimId, order.id, `0x${'00'.repeat(32)}`]);
      } else if (r.status === 'order_created' && r.shopifyOrder) {
        const d = await admin<{ order: { displayFulfillmentStatus: string; fulfillments: { trackingInfo: { number: string | null; company: string | null }[] }[] } | null }>(
          `query($id: ID!) { order(id: $id) { displayFulfillmentStatus fulfillments { trackingInfo { number company } } } }`,
          { id: r.shopifyOrder },
        );
        if (d.order?.displayFulfillmentStatus === 'FULFILLED') {
          const t = d.order.fulfillments.flatMap((f) => f.trackingInfo)[0];
          const tracking = t?.number ? `${t.company ?? ''} ${t.number}`.trim() : 'fulfilled';
          redemptions.update(r.claimId, { status: 'shipped', tracking });
          if (process.env.RWA_LEDGER_ADDRESS) await ledgerCall('recordShipped', [r.claimId, tracking]);
        }
      }
    } catch (err) {
      redemptions.update(r.claimId, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function startShopify() {
  if (!shopifyConfigured()) {
    console.log('[shopify] SHOPIFY_STORE_DOMAIN + client id/secret (or SHOPIFY_ADMIN_TOKEN) not set — store not connected');
    return;
  }
  setOrderCreator(createOrder);
  console.log(`[shopify] connected to ${process.env.SHOPIFY_STORE_DOMAIN}`);
  void syncShopify();
  setInterval(() => void syncShopify(), POLL_MS);
}
