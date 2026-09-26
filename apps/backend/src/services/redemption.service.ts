// Redemptions: a paid claim burned on Sui becomes a paid Shopify order for the merchant to ship.
// The holder registers a shipping address first; when the mirror sees the on-chain `Redeemed`
// event it creates the order (via the Shopify app, once connected) and the order reference is
// recorded on the MultiBaas RWA ledger.
import fs from 'fs';
import path from 'path';

const FILE = path.resolve(__dirname, '../../data/redemptions.json');

export interface Shipping {
  name: string;
  address1: string;
  city: string;
  zip: string;
  country: string; // ISO code, e.g. "US"
  email?: string;
}

export interface Redemption {
  claimId: string;
  wallet: string;
  humanKey: string;
  itemName?: string;
  shipping: Shipping;
  status: 'awaiting_redeem_tx' | 'redeemed' | 'order_created' | 'shipped' | 'order_failed';
  suiTx?: string;
  shopifyOrder?: string; // order gid
  shopifyOrderName?: string; // e.g. #1001
  tracking?: string;
  error?: string;
  updatedAt: string;
}

function load(): Record<string, Redemption> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}
let store = load();
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(store, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
}

const norm = (id: string) => `0x${id.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

export const redemptions = {
  get: (claimId: string) => store[norm(claimId)],
  forWallet: (wallet: string) => Object.values(store).filter((r) => r.wallet === wallet),
  all: () => Object.values(store),
  upsert(r: Omit<Redemption, 'updatedAt'>) {
    store = { ...store, [norm(r.claimId)]: { ...r, claimId: norm(r.claimId), updatedAt: new Date().toISOString() } };
    save();
    return store[norm(r.claimId)];
  },
  update(claimId: string, patch: Partial<Redemption>) {
    const cur = store[norm(claimId)];
    if (!cur) return undefined;
    store = { ...store, [norm(claimId)]: { ...cur, ...patch, updatedAt: new Date().toISOString() } };
    save();
    return store[norm(claimId)];
  },
};

// The Shopify app registers how to create an order; until then redemptions wait for it.
type OrderCreator = (r: Redemption) => Promise<{ id: string; name: string }>;
let createOrder: OrderCreator | null = null;
export function setOrderCreator(fn: OrderCreator) {
  createOrder = fn;
}
export const orderCreatorReady = () => !!createOrder;

/** Called by the mirror for an on-chain `Redeemed` event. Returns the order reference for the ledger. */
export async function onRedeemed(claimId: string, suiTx: string, itemName: string): Promise<string> {
  const r = redemptions.update(claimId, { status: 'redeemed', suiTx, itemName });
  if (!r) return ''; // redeemed without registering an address (e.g. directly on-chain)
  if (!createOrder) return ''; // Shopify not connected yet: order is created when it is (retryPendingOrders)
  try {
    const order = await createOrder(r);
    redemptions.update(claimId, { status: 'order_created', shopifyOrder: order.id, shopifyOrderName: order.name, error: undefined });
    return order.id;
  } catch (err) {
    redemptions.update(claimId, { status: 'order_failed', error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}
