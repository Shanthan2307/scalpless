// Point the on-chain Registry at the backend's current attestation key.
//
//   pnpm rotate-verifier            # dry run: shows current vs. new key, sends nothing
//   pnpm rotate-verifier --execute  # submits registry::rotate_verifier
//
// Signs with the AdminCap owner (SUI_DEPLOYER_PRIVATE_KEY). Uses gRPC + GraphQL (public JSON-RPC
// is retired). Only needed after changing ATTESTATION_SIGNER_KEY — deploy-sui sets it initially.
import path from 'path';
import dotenv from 'dotenv';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { toHex } from '@mysten/sui/utils';

const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const GRAPHQL = 'https://graphql.testnet.sui.io/graphql';
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set in .env`);
  return v;
};

function adminKeypair(): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(need('SUI_DEPLOYER_PRIVATE_KEY')).secretKey);
}

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const body = (await res.json()) as { data: T; errors?: unknown };
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const packageId = need('NEXT_PUBLIC_SCALPLESS_PACKAGE_ID');
  const registryId = need('NEXT_PUBLIC_REGISTRY_OBJECT_ID');
  const signerKey = need('ATTESTATION_SIGNER_KEY').replace(/^0x/, '');
  const newPubkey = Ed25519Keypair.fromSecretKey(Buffer.from(signerKey, 'hex')).getPublicKey().toRawBytes();

  const admin = adminKeypair();
  const adminAddr = admin.toSuiAddress();

  const data = await gql<{
    registry: { asMoveObject: { contents: { json: { verifier_pubkey: string } } } } | null;
    caps: { nodes: { address: string }[] };
  }>(`{
    registry: object(address: "${registryId}") { asMoveObject { contents { json } } }
    caps: objects(filter: { type: "${packageId}::registry::AdminCap", owner: "${adminAddr}" }) { nodes { address } }
  }`);
  if (!data.registry) throw new Error(`Registry ${registryId} not found`);
  const current = toHex(Buffer.from(data.registry.asMoveObject.contents.json.verifier_pubkey, 'base64'));
  const cap = data.caps.nodes[0]?.address;

  console.log(`Registry        ${registryId}`);
  console.log(`Admin signer    ${adminAddr}`);
  console.log(`AdminCap        ${cap ?? 'NOT OWNED BY THIS SIGNER'}`);
  console.log(`Current pubkey  ${current}`);
  console.log(`New pubkey      ${toHex(newPubkey)}`);
  if (!cap) throw new Error('this signer does not own the AdminCap');
  if (current === toHex(newPubkey)) return console.log('Already up to date.');
  if (!execute) return console.log('\nDry run. Re-run with --execute to submit.');

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::registry::set_verifier`,
    arguments: [tx.object(cap), tx.object(registryId), tx.pure.vector('u8', Array.from(newPubkey))],
  });
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
  const result = await client.signAndExecuteTransaction({ transaction: tx, signer: admin });
  const txn = result.Transaction ?? result.FailedTransaction;
  console.log(`\n${result.$kind} ${txn.digest}`);
  if (result.$kind !== 'Transaction') process.exit(1);
  console.log(`https://suiscan.xyz/testnet/tx/${txn.digest}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
