// Publish the Scalpless Move package to Sui testnet and initialize it.
//
//   pnpm deploy:sui                          # publish + initialize
//   pnpm deploy:sui --from-publish <DIGEST>  # initialize an existing publish
//
// Tx 1: publish (UpgradeCap → deployer). `init` creates Registry, PassportRegistry, Market (shared),
//       the AdminCap and both LP TreasuryCaps (→ deployer).
// Tx 2: finalize the LP coin registrations, set the attestation verifier to the backend's key,
//       create the LendingPool (UnderwriterCap → deployer, which is also the backend operator).
// Writes the object IDs to .env and packages/sui-contracts/deployments/testnet.json.
// Signs with SUI_DEPLOYER_PRIVATE_KEY; uses gRPC (public JSON-RPC is retired).
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'packages/sui-contracts');
const ENV_PATH = path.join(ROOT, '.env');
dotenv.config({ path: ENV_PATH, quiet: true } as dotenv.DotenvConfigOptions);

// Pool parameters sized for live demos: 10-minute loans (2.5-minute installments), 2-minute grace.
const SENIOR_FEE_SHARE_BPS = 4_000;
const TERM_MS = 10 * 60_000;
const GRACE_MS = 2 * 60_000;

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set in .env`);
  return v;
};

function setEnv(key: string, value: string) {
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  const line = `${key}="${value}"`;
  env = new RegExp(`^${key}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${env.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, env);
}

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(need('SUI_DEPLOYER_PRIVATE_KEY')).secretKey);
const deployer = signer.toSuiAddress();

async function run(tx: Transaction, label: string) {
  // (returns the executed transaction with effects + objectTypes)
  tx.setSender(deployer);
  tx.setGasBudget(500_000_000);
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true, objectTypes: true } });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (res.$kind !== 'Transaction') throw new Error(`${label} failed (${t.digest}): ${t.status.error?.message}`);
  await client.waitForTransaction({ digest: t.digest });
  console.log(`${label}: ${t.digest}`);
  return t;
}

function created(t: Awaited<ReturnType<typeof run>>, typeSuffix: string): string {
  const types = t.objectTypes ?? {};
  const hit = t.effects!.changedObjects.find((o) => o.idOperation === 'Created' && types[o.objectId]?.endsWith(typeSuffix));
  if (!hit) throw new Error(`no created object of type …${typeSuffix}`);
  return hit.objectId;
}

async function main() {
  const attestationPubkey = Ed25519Keypair.fromSecretKey(Buffer.from(need('ATTESTATION_SIGNER_KEY').replace(/^0x/, ''), 'hex'))
    .getPublicKey()
    .toRawBytes();

  const balance = await client.getBalance({ owner: deployer });
  console.log(`deployer ${deployer} · ${Number(balance.balance.balance) / 1e9} SUI`);
  if (BigInt(balance.balance.balance) < 1_000_000_000n) throw new Error('fund the deployer with ≥ 1 testnet SUI (https://faucet.sui.io)');

  const resume = process.argv.indexOf('--from-publish');
  let t1: Awaited<ReturnType<typeof run>>;
  if (resume > 0) {
    const res = await client.getTransaction({ digest: process.argv[resume + 1], include: { effects: true, objectTypes: true } });
    t1 = (res.Transaction ?? res.FailedTransaction)!;
    console.log(`publish: ${t1.digest} (existing)`);
  } else {
    const build = JSON.parse(execSync('sui move build --dump-bytecode-as-base64', { cwd: PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const publish = new Transaction();
    const [upgradeCap] = publish.publish({ modules: build.modules, dependencies: build.dependencies });
    publish.transferObjects([upgradeCap], deployer);
    t1 = await run(publish, 'publish');
  }

  const packageId = t1.effects!.changedObjects.find((o) => o.outputState === 'PackageWrite')!.objectId;
  const ids = {
    packageId,
    registry: created(t1, '::registry::Registry'),
    adminCap: created(t1, '::registry::AdminCap'),
    passportRegistry: created(t1, '::passport::PassportRegistry'),
    market: created(t1, '::market::Market'),
    seniorCap: created(t1, `::coin::TreasuryCap<${packageId}::senior_lp::SENIOR_LP>`),
    juniorCap: created(t1, `::coin::TreasuryCap<${packageId}::junior_lp::JUNIOR_LP>`),
    seniorCurrency: created(t1, `::coin_registry::Currency<${packageId}::senior_lp::SENIOR_LP>`),
    juniorCurrency: created(t1, `::coin_registry::Currency<${packageId}::junior_lp::JUNIOR_LP>`),
  };

  const setup = new Transaction();
  for (const [lp, currency] of [['senior_lp::SENIOR_LP', ids.seniorCurrency], ['junior_lp::JUNIOR_LP', ids.juniorCurrency]] as const) {
    setup.moveCall({
      target: '0x2::coin_registry::finalize_registration',
      typeArguments: [`${packageId}::${lp}`],
      arguments: [setup.object('0xc'), setup.object(currency)],
    });
  }
  setup.moveCall({
    target: `${packageId}::registry::set_verifier`,
    arguments: [setup.object(ids.adminCap), setup.object(ids.registry), setup.pure.vector('u8', Array.from(attestationPubkey))],
  });
  const [uwCap] = setup.moveCall({
    target: `${packageId}::lending::create_pool`,
    arguments: [
      setup.object(ids.adminCap),
      setup.object(ids.seniorCap),
      setup.object(ids.juniorCap),
      setup.pure.u64(SENIOR_FEE_SHARE_BPS),
      setup.pure.u64(TERM_MS),
      setup.pure.u64(GRACE_MS),
    ],
  });
  setup.transferObjects([uwCap], deployer);
  const t2 = await run(setup, 'initialize');
  const lendingPool = created(t2, '::lending::LendingPool');
  const underwriterCap = created(t2, '::lending::UnderwriterCap');

  setEnv('NEXT_PUBLIC_SCALPLESS_PACKAGE_ID', packageId);
  setEnv('NEXT_PUBLIC_REGISTRY_OBJECT_ID', ids.registry);
  setEnv('NEXT_PUBLIC_PASSPORT_REGISTRY_ID', ids.passportRegistry);
  setEnv('NEXT_PUBLIC_LENDING_POOL_OBJECT_ID', lendingPool);
  setEnv('NEXT_PUBLIC_MARKET_OBJECT_ID', ids.market);
  setEnv('SUI_ADMIN_CAP_ID', ids.adminCap);
  setEnv('SUI_UNDERWRITER_CAP_ID', underwriterCap);

  const record = {
    network: 'testnet',
    deployedAt: new Date().toISOString(),
    deployer,
    packageId,
    registry: ids.registry,
    passportRegistry: ids.passportRegistry,
    market: ids.market,
    lendingPool,
    adminCap: ids.adminCap,
    underwriterCap,
    pool: { seniorFeeShareBps: SENIOR_FEE_SHARE_BPS, termMs: TERM_MS, graceMs: GRACE_MS },
    transactions: { publish: t1.digest, initialize: t2.digest },
  };
  fs.mkdirSync(path.join(PKG_DIR, 'deployments'), { recursive: true });
  fs.writeFileSync(path.join(PKG_DIR, 'deployments/testnet.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
