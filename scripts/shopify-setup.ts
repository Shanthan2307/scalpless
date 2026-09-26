// One-time (idempotent) storefront setup for ScalpLess-curve:
//   * "Drops" smart collection = every product tagged scalpless-drop
//   * publish it, and every drop product, to the Online Store
//   * add "Drops" to the main menu
//   pnpm shopify:setup
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true } as dotenv.DotenvConfigOptions);
const e = process.env;
const DOMAIN = e.SHOPIFY_STORE_DOMAIN!;

let token = '';
async function admin<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!token) {
    const r = (await (await fetch(`https://${DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: e.SHOPIFY_CLIENT_ID!, client_secret: e.SHOPIFY_CLIENT_SECRET! }),
    })).json()) as { access_token: string; scope: string };
    token = r.access_token;
    console.log(`granted scopes: ${r.scope}`);
  }
  const res = await fetch(`https://${DOMAIN}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors) throw new Error(body.errors.map((x) => x.message).join('; '));
  return body.data as T;
}

async function step(label: string, fn: () => Promise<string>) {
  try {
    console.log(`✓ ${label}: ${await fn()}`);
  } catch (err) {
    console.log(`✕ ${label}: ${err instanceof Error ? err.message : err}`);
  }
}

async function onlineStore(): Promise<string> {
  const d = await admin<{ publications: { nodes: { id: string; name: string }[] } }>(`{ publications(first: 20) { nodes { id name } } }`);
  const p = d.publications.nodes.find((n) => /online store/i.test(n.name));
  if (!p) throw new Error('Online Store sales channel not found');
  return p.id;
}

async function publish(id: string, publicationId: string) {
  const d = await admin<{ publishablePublish: { userErrors: { message: string }[] } }>(
    `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
    { id, input: [{ publicationId }] },
  );
  if (d.publishablePublish.userErrors.length) throw new Error(d.publishablePublish.userErrors.map((x) => x.message).join('; '));
}

async function main() {
  let collectionId = '';
  await step('Drops collection', async () => {
    const found = await admin<{ collectionByHandle: { id: string } | null }>(`{ collectionByHandle(handle: "drops") { id } }`);
    if (found.collectionByHandle) {
      collectionId = found.collectionByHandle.id;
      return `exists (${collectionId})`;
    }
    const d = await admin<{ collectionCreate: { collection: { id: string } | null; userErrors: { message: string }[] } }>(
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { message } } }`,
      {
        input: {
          title: 'Drops',
          handle: 'drops',
          descriptionHtml: '<p>Fair drops: one entry per World ID-verified human. Winners are drawn on-chain.</p>',
          ruleSet: { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'scalpless-drop' }] },
        },
      },
    );
    if (d.collectionCreate.userErrors.length) throw new Error(d.collectionCreate.userErrors.map((x) => x.message).join('; '));
    collectionId = d.collectionCreate.collection!.id;
    return `created (${collectionId})`;
  });

  await step('Publish Drops collection + drop products to the Online Store', async () => {
    const pub = await onlineStore();
    if (collectionId) await publish(collectionId, pub);
    const d = await admin<{ products: { nodes: { id: string; title: string }[] } }>(`{ products(first: 50, query: "tag:scalpless-drop") { nodes { id title } } }`);
    for (const p of d.products.nodes) await publish(p.id, pub);
    return `${d.products.nodes.length} drop product(s) published`;
  });

  await step('Add "Drops" to the main menu', async () => {
    if (!collectionId) throw new Error('no Drops collection');
    const d = await admin<{ menus: { nodes: { id: string; handle: string; title: string; items: { id: string; title: string; type: string; resourceId: string | null; url: string | null }[] }[] } }>(
      `{ menus(first: 10) { nodes { id handle title items { id title type resourceId url } } } }`,
    );
    const menu = d.menus.nodes.find((m) => m.handle === 'main-menu') ?? d.menus.nodes[0];
    if (!menu) throw new Error('no menu found');
    if (menu.items.some((i) => i.title === 'Drops')) return 'already in the menu';
    const items = menu.items.map((i) => ({ id: i.id, title: i.title, type: i.type, resourceId: i.resourceId, url: i.url }));
    const at = Math.max(0, items.findIndex((i) => /contact/i.test(i.title)));
    items.splice(at === 0 && !items.some((i) => /contact/i.test(i.title)) ? items.length : at, 0, { title: 'Drops', type: 'COLLECTION', resourceId: collectionId } as never);
    const u = await admin<{ menuUpdate: { userErrors: { message: string }[] } }>(
      `mutation($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) { menuUpdate(id: $id, title: $title, handle: $handle, items: $items) { userErrors { message } } }`,
      { id: menu.id, title: menu.title, handle: menu.handle, items },
    );
    if (u.menuUpdate.userErrors.length) throw new Error(u.menuUpdate.userErrors.map((x) => x.message).join('; '));
    return `added to "${menu.title}"`;
  });
}

main();
