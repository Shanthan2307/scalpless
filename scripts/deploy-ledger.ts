// Deploy ScalplessRWALedger to Base Sepolia through Curvegrid MultiBaas.
//
//   pnpm deploy:ledger
//
// 1. forge build, then upload the ABI + bytecode to the MultiBaas contract library
// 2. MultiBaas builds the deployment tx; the operator key (EVM_OPERATOR_PRIVATE_KEY) signs it;
//    MultiBaas submits it
// 3. alias the new address `scalpless_ledger` and link it to the contract so MultiBaas indexes events
// Idempotent: re-running skips steps that are already done.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { AddressesApi, Configuration } from '@curvegrid/multibaas-sdk';

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
dotenv.config({ path: ENV_PATH, quiet: true } as dotenv.DotenvConfigOptions);

const VERSION = '1.0';

function setEnv(key: string, value: string) {
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${env.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, env);
}

async function main() {
  const { mb, operator, baseClient, signAndSubmit, LEDGER_LABEL, LEDGER_ALIAS } = await import('../apps/backend/src/services/multibaas.service');
  const addresses = new AddressesApi(new Configuration({ basePath: `${process.env.MULTIBAAS_URL!.replace(/\/$/, '')}/api/v0`, accessToken: process.env.MULTIBAAS_API_KEY }));
  const op = operator().address;

  const balance = await baseClient.getBalance({ address: op });
  console.log(`operator ${op} · ${Number(balance) / 1e18} Base Sepolia ETH`);

  // 1. compile + upload to the MultiBaas contract library
  execSync('forge build', { cwd: path.join(ROOT, 'packages/evm-contracts'), stdio: 'ignore' });
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/evm-contracts/out/ScalplessRWALedger.sol/ScalplessRWALedger.json'), 'utf8'));
  try {
    await mb().contracts.getContract(LEDGER_LABEL);
    console.log(`contract "${LEDGER_LABEL}" already in the MultiBaas library`);
  } catch {
    await mb().contracts.createContract(LEDGER_LABEL, {
      label: LEDGER_LABEL,
      contractName: 'ScalplessRWALedger',
      version: VERSION,
      bin: artifact.bytecode.object,
      rawAbi: JSON.stringify(artifact.abi),
    });
    console.log(`uploaded "${LEDGER_LABEL}" v${VERSION} to the MultiBaas library`);
  }

  // Already deployed + aliased? Then we're done.
  try {
    const existing = await addresses.getAddress(LEDGER_ALIAS);
    const { address, contracts } = existing.data.result as { address: string; contracts: unknown[] };
    console.log(`ledger already deployed at ${address} (alias ${LEDGER_ALIAS})`);
    if (contracts.length === 0) {
      await mb().contracts.linkAddressContract(LEDGER_ALIAS, { label: LEDGER_LABEL, version: VERSION });
      console.log(`linked ${LEDGER_ALIAS} to ${LEDGER_LABEL} v${VERSION}`);
    }
    setEnv('RWA_LEDGER_ADDRESS', address);
    return;
  } catch {
    /* not deployed yet */
  }
  if (balance === 0n) throw new Error(`fund ${op} with Base Sepolia ETH first`);

  // 2. deploy (built by MultiBaas, signed by the operator)
  const deploy = await mb().contracts.deployContract(LEDGER_LABEL, { from: op, args: [op] });
  const receipt = await signAndSubmit(deploy.data.result.tx);
  const address = receipt.contractAddress!;
  console.log(`deployed ScalplessRWALedger at ${address} · tx ${receipt.transactionHash}`);

  // 3. alias + link so MultiBaas indexes its events
  await addresses.setAddress({ alias: LEDGER_ALIAS, address });
  for (let attempt = 0; ; attempt++) {
    try {
      await mb().contracts.linkAddressContract(LEDGER_ALIAS, { label: LEDGER_LABEL, version: VERSION, startingBlock: String(receipt.blockNumber) });
      break;
    } catch (err) {
      if (attempt >= 5) throw err; // MultiBaas may not have indexed the deploy block yet
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(`aliased ${LEDGER_ALIAS} and linked to ${LEDGER_LABEL} v${VERSION}`);

  setEnv('RWA_LEDGER_ADDRESS', address);
  const record = { network: 'base-sepolia', chainId: 84532, address, operator: op, deployTx: receipt.transactionHash, block: String(receipt.blockNumber), multibaas: { label: LEDGER_LABEL, alias: LEDGER_ALIAS, version: VERSION } };
  fs.writeFileSync(path.join(ROOT, 'packages/evm-contracts/deployments.base-sepolia.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error(e?.response?.data ? JSON.stringify(e.response.data) : e instanceof Error ? e.message : e);
  process.exit(1);
});
