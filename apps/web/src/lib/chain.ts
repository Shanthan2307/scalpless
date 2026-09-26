// Read Scalpless state straight from Sui (GraphQL). Nothing here is cached or mocked: every number
// the UI shows comes from these queries.
import { bcs } from '@mysten/sui/bcs';
import { fromBase64, fromHex, toHex } from '@mysten/sui/utils';
import { NETWORK, PACKAGE_ID, PASSPORT_REGISTRY_ID, LENDING_POOL_OBJECT_ID, MARKET_OBJECT_ID } from './constants';

const GRAPHQL_URL = `https://graphql.${NETWORK}.sui.io/graphql`;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

type Node<J> = { address: string; asMoveObject: { contents: { json: J } } };

/** Move `vector<u8>` comes back base64 in JSON. */
export const b64ToHex = (b64: string) => `0x${toHex(fromBase64(b64))}`;
export const mist = (v: string | number | bigint) => Number(v) / 1e9;
export const toMist = (sui: string) => BigInt(Math.round(parseFloat(sui) * 1e9));

// ---- types (JSON shape of the Move structs) ---------------------------------------------------

export interface DropJson {
  title: string;
  seller: string;
  face_price_mist: string;
  deposit_mist: string;
  total_units: string;
  min_tier: number;
  entry_deadline_ms: string;
  claim_window_ms: string;
  installment_interval_ms: string;
  status: number;
  vault: string;
  entries: { human_key: string; beneficiary: string; payer: string; tier: number; tickets: string; round_won: number }[];
  waitlist: unknown[];
}
export interface ClaimJson {
  drop_id: string;
  item_name: string;
  holder: string;
  human_key: string;
  seller: string;
  face_price_mist: string;
  deposit_mist: string;
  claim_deadline_ms: string;
  status: number;
}
export interface PlanJson {
  claim_id: string;
  drop_id: string;
  buyer: string;
  human_key: string;
  total_mist: string;
  paid_mist: string;
  installment_mist: string;
  installments_paid: number;
  next_due_ms: string;
  status: number;
}
export interface PoolJson {
  cash: string;
  senior_assets: string;
  junior_assets: string;
  senior_cap: { total_supply: { value: string } };
  junior_cap: { total_supply: { value: string } };
  senior_fee_share_bps: string;
  term_ms: string;
  grace_ms: string;
  outstanding_principal: string;
  total_losses: string;
  terms: { id: string; size: string };
  loans: { id: string; size: string };
}
export interface PassportJson {
  owner: string;
  credential_tier: number;
  standing: number;
  score: string;
  credit_limit_mist: string;
  on_time_repayments: string;
  late_marks: string;
  defaults: string;
  completed_layaways: string;
  drop_losses: string;
  active_loan: boolean;
  agents: string[];
}
export interface LoanJson {
  borrower: string;
  claim_id: string;
  principal_mist: string;
  fee_mist: string;
  repaid_principal_mist: string;
  repaid_fee_mist: string;
  installment_mist: string;
  started_ms: string;
  late_marked: boolean;
}
export interface TermsJson {
  max_principal_mist: string;
  fee_bps: string;
  risk_band: number;
  expiry_ms: string;
}
export interface ListingJson {
  seller: string;
  seller_human: string;
  ask_mist: string;
  face_price_mist: string;
  drop_id: string;
}

export const CLAIM_STATUS = ['Won — verify liveness', 'Liveness verified — settle', 'In layaway', 'Paid — ready to ship', 'Listed for resale'];
export const STANDING = ['Good', 'Late', 'Locked out'];

// ---- queries ----------------------------------------------------------------------------------

async function objectsOfType<J>(type: string): Promise<{ id: string; json: J }[]> {
  const data = await gql<{ objects: { nodes: Node<J>[] } }>(
    `query($type: String!) { objects(filter: { type: $type }, first: 50) { nodes { address asMoveObject { contents { json } } } } }`,
    { type },
  );
  return data.objects.nodes.map((n) => ({ id: n.address, json: n.asMoveObject.contents.json }));
}

async function ownedOfType<J>(owner: string, type: string): Promise<{ id: string; json: J }[]> {
  // Owned-object nodes are already MoveObjects: `contents` sits at the top level.
  const data = await gql<{ address: { objects: { nodes: { address: string; contents: { json: J } }[] } } | null }>(
    `query($owner: SuiAddress!, $type: String!) {
      address(address: $owner) { objects(filter: { type: $type }, first: 50) { nodes { address contents { json } } } }
    }`,
    { owner, type },
  );
  return (data.address?.objects.nodes ?? []).map((n) => ({ id: n.address, json: n.contents.json }));
}

async function objectJson<J>(id: string): Promise<J | null> {
  const data = await gql<{ object: Node<J> | null }>(`query($id: SuiAddress!) { object(address: $id) { address asMoveObject { contents { json } } } }`, { id });
  return data.object?.asMoveObject.contents.json ?? null;
}

async function tableEntry<J>(tableId: string, keyType: string, keyBcs: Uint8Array): Promise<J | null> {
  const data = await gql<{ address: { dynamicField: { value: { json: J } } | null } | null }>(
    `query($table: SuiAddress!, $type: String!, $key: Base64!) {
      address(address: $table) { dynamicField(name: { type: $type, bcs: $key }) { value { ... on MoveValue { json } } } }
    }`,
    { table: tableId, type: keyType, key: btoa(String.fromCharCode(...keyBcs)) },
  );
  return data.address?.dynamicField?.value.json ?? null;
}

async function tableEntries<K, J>(tableId: string): Promise<{ key: K; value: J }[]> {
  const data = await gql<{ address: { dynamicFields: { nodes: { name: { json: K }; value: { json: J } }[] } } | null }>(
    `query($table: SuiAddress!) { address(address: $table) { dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } } } }`,
    { table: tableId },
  );
  return (data.address?.dynamicFields.nodes ?? []).map((n) => ({ key: n.name.json, value: n.value.json }));
}

const humanKeyBcs = (humanKeyHex: string) =>
  bcs.vector(bcs.u8()).serialize(Array.from(fromHex(humanKeyHex))).toBytes();

export const fetchDrops = () => objectsOfType<DropJson>(`${PACKAGE_ID}::drop::Drop`);
export const fetchPlans = () => objectsOfType<PlanJson>(`${PACKAGE_ID}::settlement::LayawayPlan`);
export const fetchMyClaims = (owner: string) => ownedOfType<ClaimJson>(owner, `${PACKAGE_ID}::claim::Claim`);
export const fetchPool = () => objectJson<PoolJson>(LENDING_POOL_OBJECT_ID);

export async function fetchPassport(humanKeyHex: string): Promise<PassportJson | null> {
  const preg = await objectJson<{ passports: { id: string } }>(PASSPORT_REGISTRY_ID);
  return preg ? tableEntry<PassportJson>(preg.passports.id, 'vector<u8>', humanKeyBcs(humanKeyHex)) : null;
}

export async function fetchLoans(pool: PoolJson) {
  return (await tableEntries<string, LoanJson>(pool.loans.id)).map((e) => ({ humanKey: b64ToHex(e.key), loan: e.value }));
}

export async function fetchTerms(pool: PoolJson, humanKeyHex: string) {
  return tableEntry<TermsJson>(pool.terms.id, 'vector<u8>', humanKeyBcs(humanKeyHex));
}

/** Listed claims are owned by the Market object (transfer-to-object); asks come from its table. */
export async function fetchListings() {
  const market = await objectJson<{ listings: { id: string } }>(MARKET_OBJECT_ID);
  if (!market) return [];
  const [claims, listings] = await Promise.all([
    ownedOfType<ClaimJson>(MARKET_OBJECT_ID, `${PACKAGE_ID}::claim::Claim`),
    tableEntries<string, ListingJson>(market.listings.id),
  ]);
  return claims
    .map((c) => ({ ...c, listing: listings.find((l) => l.key === c.id)?.value }))
    .filter((c): c is typeof c & { listing: ListingJson } => !!c.listing);
}

export async function fetchBalance(owner: string, coinType: string): Promise<bigint> {
  const data = await gql<{ address: { balance: { totalBalance: string } | null } | null }>(
    `query($owner: SuiAddress!, $type: String!) { address(address: $owner) { balance(coinType: $type) { totalBalance } } }`,
    { owner, type: coinType },
  );
  return BigInt(data.address?.balance?.totalBalance ?? 0);
}

export const SENIOR_LP_TYPE = `${PACKAGE_ID}::senior_lp::SENIOR_LP`;
export const JUNIOR_LP_TYPE = `${PACKAGE_ID}::junior_lp::JUNIOR_LP`;

export const amountOwed = (l: LoanJson) =>
  BigInt(l.principal_mist) - BigInt(l.repaid_principal_mist) + BigInt(l.fee_mist) - BigInt(l.repaid_fee_mist);
