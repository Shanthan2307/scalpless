// Sui drop → Shopify product/variant links. Own file, read fresh on each access and written
// atomically, so no other process's in-memory state can overwrite a link.
import fs from 'fs';
import path from 'path';

const FILE = path.resolve(__dirname, '../../data/shopify-links.json');

export interface ShopifyLink {
  productId: string;
  variantId: string;
  linkedAt: string;
}

const norm = (id: string) => `0x${id.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

function read(): Record<string, ShopifyLink> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function getShopifyLink(dropId: string): ShopifyLink | undefined {
  return read()[norm(dropId)];
}

export function setShopifyLink(dropId: string, link: Omit<ShopifyLink, 'linkedAt'>) {
  const all = { ...read(), [norm(dropId)]: { ...link, linkedAt: new Date().toISOString() } };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
}
