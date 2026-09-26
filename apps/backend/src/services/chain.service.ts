// Sui access for the backend: GraphQL for reads, gRPC for the operator's transactions
// (public JSON-RPC is retired).
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { bcs } from '@mysten/sui/bcs';
import { env } from '../config/env';

const GRAPHQL_URL = `https://graphql.${env.SUI_NETWORK}.sui.io/graphql`;

export const grpc = new SuiGrpcClient({ network: env.SUI_NETWORK as 'testnet', baseUrl: `https://fullnode.${env.SUI_NETWORK}.sui.io:443` });

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Sui GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data as T;
}

export async function objectJson<T>(id: string): Promise<T | null> {
  const data = await gql<{ object: { asMoveObject: { contents: { json: T } } } | null }>(
    `query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { json } } } }`,
    { id },
  );
  return data.object?.asMoveObject.contents.json ?? null;
}

/** Read one `Table<vector<u8>, V>` entry (tables store entries as dynamic fields of the table id). */
export async function tableEntry<T>(tableId: string, key: Uint8Array): Promise<T | null> {
  const data = await gql<{ address: { dynamicField: { value: { json: T } } | null } | null }>(
    `query($table: SuiAddress!, $key: Base64!) {
      address(address: $table) { dynamicField(name: { type: "vector<u8>", bcs: $key }) { value { ... on MoveValue { json } } } }
    }`,
    { table: tableId, key: Buffer.from(bcs.vector(bcs.u8()).serialize(Array.from(key)).toBytes()).toString('base64') },
  );
  return data.address?.dynamicField?.value.json ?? null;
}

let operator: Ed25519Keypair | null = null;
export function operatorKeypair(): Ed25519Keypair {
  if (!operator) {
    const key = process.env.SUI_DEPLOYER_PRIVATE_KEY?.trim();
    if (!key) throw new Error('[env] SUI_DEPLOYER_PRIVATE_KEY is not set (run pnpm deploy:sui)');
    operator = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(key).secretKey);
  }
  return operator;
}

/** Sign and execute as the protocol operator; throws on an on-chain failure. */
export async function executeAsOperator(tx: Transaction): Promise<string> {
  const signer = operatorKeypair();
  tx.setSender(signer.toSuiAddress());
  const res = await grpc.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (res.$kind !== 'Transaction') throw new Error(`transaction ${t.digest} failed: ${t.status.error?.message}`);
  await grpc.waitForTransaction({ digest: t.digest });
  return t.digest;
}
