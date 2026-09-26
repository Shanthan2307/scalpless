// Deployment IDs come from the repo-root .env (loaded by next.config.mjs). No hardcoded
// fallbacks: a missing ID should break loudly, not silently point at an old deployment.
function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

export const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet') as 'testnet';
export const SUI_RPC_URL = process.env.NEXT_PUBLIC_SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
// Original package id: names every Scalpless type (types never change across upgrades).
export const PACKAGE_ID = need('NEXT_PUBLIC_SCALPLESS_PACKAGE_ID', process.env.NEXT_PUBLIC_SCALPLESS_PACKAGE_ID);
// Latest upgrade: where function calls go (includes modules added later, e.g. `redeem`).
export const CALL_PACKAGE_ID = process.env.NEXT_PUBLIC_SCALPLESS_LATEST_PACKAGE_ID || PACKAGE_ID;
export const PASSPORT_REGISTRY_ID = need('NEXT_PUBLIC_PASSPORT_REGISTRY_ID', process.env.NEXT_PUBLIC_PASSPORT_REGISTRY_ID);
export const REGISTRY_OBJECT_ID = need('NEXT_PUBLIC_REGISTRY_OBJECT_ID', process.env.NEXT_PUBLIC_REGISTRY_OBJECT_ID);
export const LENDING_POOL_OBJECT_ID = need('NEXT_PUBLIC_LENDING_POOL_OBJECT_ID', process.env.NEXT_PUBLIC_LENDING_POOL_OBJECT_ID);
export const MARKET_OBJECT_ID = need('NEXT_PUBLIC_MARKET_OBJECT_ID', process.env.NEXT_PUBLIC_MARKET_OBJECT_ID);

export const CLOCK_OBJECT_ID = '0x6';
export const RANDOM_OBJECT_ID = '0x8';
