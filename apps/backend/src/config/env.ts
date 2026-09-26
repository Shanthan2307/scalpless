import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

// Secrets and deployment IDs have NO fallbacks: a missing value must fail loudly at boot,
// never silently drop to a placeholder (the old build shipped a well-known signing key).
function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[env] ${name} is not set — see .env.example`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const env = {
  PORT: parseInt(optional('PORT', '4000'), 10),

  // Sui deployment (from scripts/deploy-sui.ts output)
  SUI_NETWORK: optional('NEXT_PUBLIC_SUI_NETWORK', 'testnet'),
  PACKAGE_ID: required('NEXT_PUBLIC_SCALPLESS_PACKAGE_ID'), // original: names types
  CALL_PACKAGE_ID: optional('NEXT_PUBLIC_SCALPLESS_LATEST_PACKAGE_ID', process.env.NEXT_PUBLIC_SCALPLESS_PACKAGE_ID ?? ''), // latest upgrade
  PASSPORT_REGISTRY_ID: required('NEXT_PUBLIC_PASSPORT_REGISTRY_ID'),
  REGISTRY_OBJECT_ID: required('NEXT_PUBLIC_REGISTRY_OBJECT_ID'),
  LENDING_POOL_OBJECT_ID: required('NEXT_PUBLIC_LENDING_POOL_OBJECT_ID'),
  MARKET_OBJECT_ID: required('NEXT_PUBLIC_MARKET_OBJECT_ID'),

  // Ed25519 key the backend uses to sign attestations that the Move `registry` verifies.
  // Its public key must equal Registry.verifier_pubkey on-chain (scripts/rotate-verifier.ts).
  ATTESTATION_SIGNER_KEY: required('ATTESTATION_SIGNER_KEY'),

  // World ID v4 (developer.world.org → your app → World ID 4.0 / RP settings)
  WORLD_APP_ID: required('WORLD_APP_ID'),
  WORLD_RP_ID: required('WORLD_RP_ID'),
  WORLD_RP_SIGNING_KEY: required('WORLD_RP_SIGNING_KEY'),
  // Uniqueness action for registration. World App issues a proof for it only ONCE per human
  // (then `nullifier_replayed`), so it doubles as World-enforced "one passport per human".
  WORLD_ACTION: optional('WORLD_ACTION', 'scalpless-passport'),
  WORLD_ENVIRONMENT: optional('WORLD_ENVIRONMENT', 'production') as 'production' | 'staging',
  // Credentials requested at sign-in. `selfie` is a World preview credential — only add it
  // once World has enabled it for your app.
  WORLD_CREDENTIALS: optional('WORLD_CREDENTIALS', 'proof_of_human,passport,mnc')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // HMAC secret for the World ID session cookie.
  SESSION_SECRET: required('SESSION_SECRET'),
};
