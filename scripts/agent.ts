// Scalpless agent CLI — an AgentKit-authenticated agent acting for a World ID-verified human.
// Client signer ported from Proof-Of-Human-Drops lib/agentkit-client.ts.
//
//   pnpm agent status              # is this agent registered in AgentBook (World Chain)?
//   pnpm agent link <CODE>         # pair with the human who generated CODE in the web app
//   pnpm agent me                  # who am I acting for?
//   pnpm agent attest enter-drop <DROP_ID>   # request a delegated attestation for one object
//   pnpm agent enter <DROP_ID>     # enter a drop ON-CHAIN for the human (needs on-chain delegation)
//   pnpm agent selftest            # attacks the server must reject
//
// Env: AGENT_EVM_PRIVATE_KEY, AGENT_SUI_PRIVATE_KEY (.env), SCALPLESS_URL (default http://localhost:3000)
import path from 'path';
import dotenv from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { formatSIWEMessage, createAgentBookVerifier } from '@worldcoin/agentkit-core';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true } as dotenv.DotenvConfigOptions);

const BASE = (process.env.SCALPLESS_URL || 'http://localhost:3000').replace(/\/$/, '');
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set in .env`);
  return v;
};
const account = privateKeyToAccount(need('AGENT_EVM_PRIVATE_KEY') as Hex);
const suiSigner = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(need('AGENT_SUI_PRIVATE_KEY')).secretKey);
const suiAddress = suiSigner.toSuiAddress();

// Build the base64 AgentKit header. `domain` is the hostname WITHOUT port and `uri` the origin
// WITH port — validateAgentkitMessage checks them separately. `resources` carry the signed intent.
async function agentkitHeader(resources: string[], overrides: { nonce?: string; issuedAt?: string } = {}) {
  const url = new URL(BASE);
  const info = {
    domain: url.hostname,
    uri: `${url.protocol}//${url.host}/`,
    statement: 'Scalpless agent acting for its World ID-verified human',
    version: '1',
    chainId: 'eip155:480', // World Chain, where AgentBook lives
    type: 'eip191' as const,
    nonce: overrides.nonce ?? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''),
    issuedAt: overrides.issuedAt ?? new Date().toISOString(),
    resources,
  };
  const signature = await account.signMessage({ message: formatSIWEMessage(info, account.address) });
  const payload = { ...info, address: account.address, signature };
  return { header: Buffer.from(JSON.stringify(payload)).toString('base64'), payload };
}

async function call(method: 'GET' | 'POST', route: string, body: unknown, header?: string) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(header ? { 'x-agentkit-payload': header } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function signedCall(method: 'GET' | 'POST', route: string, body: unknown, intent: string[]) {
  const { header } = await agentkitHeader(intent);
  return call(method, route, body, header);
}

const print = (label: string, r: { status: number; body: unknown }) => console.log(`${label} → HTTP ${r.status}`, JSON.stringify(r.body));

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  console.log(`agent ${account.address} · sui ${suiAddress} · ${BASE}`);
  switch (cmd) {
    case 'status': {
      const humanId = await createAgentBookVerifier().lookupHuman(account.address);
      console.log(humanId ? `registered in AgentBook · human ${humanId.slice(0, 10)}…` : `NOT registered — run: npx @worldcoin/agentkit-cli register ${account.address}`);
      break;
    }
    case 'link': {
      if (!arg) throw new Error('usage: pnpm agent link <CODE>');
      const code = arg.toUpperCase();
      print('link', await signedCall('POST', '/api/agent/link', { code, sui_address: suiAddress }, [`urn:scalpless:link:${code}:${suiAddress}`]));
      break;
    }
    case 'me':
      print('me', await signedCall('GET', '/api/agent/me', undefined, []));
      break;
    case 'attest': {
      const [action, target] = [arg, process.argv[4]];
      if (!action || !target) throw new Error('usage: pnpm agent attest <enter-drop|buy-resale> <OBJECT_ID>');
      print(`attest ${action}`, await signedCall('POST', '/api/agent/attest', { action, target }, [`urn:scalpless:attest:${action}:${target}`]));
      break;
    }
    case 'enter': {
      if (!arg) throw new Error('usage: pnpm agent enter <DROP_ID>');
      const { enterDropTx } = await import('../apps/web/src/lib/tx');
      const { fetchDrops } = await import('../apps/web/src/lib/chain');
      const drop = (await fetchDrops()).find((d) => d.id === arg);
      if (!drop) throw new Error(`drop ${arg} not found`);
      const r = await signedCall('POST', '/api/agent/attest', { action: 'enter-drop', target: arg }, [`urn:scalpless:attest:enter-drop:${arg}`]);
      print('attest enter-drop', { status: r.status, body: { credential_tier: r.body.credential_tier, wallet: r.body.wallet } });
      if (r.status !== 200) break;
      const tx = enterDropTx(r.body as never, arg, BigInt(drop.json.deposit_mist));
      tx.setSender(suiAddress);
      const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
      const res = await client.signAndExecuteTransaction({ transaction: tx, signer: suiSigner, include: { effects: true } });
      const t = res.Transaction ?? res.FailedTransaction!;
      console.log(`enter → ${res.$kind} ${t.digest}${res.$kind === 'Transaction' ? '' : ` · ${t.status.error?.message}`}`);
      break;
    }
    case 'selftest': {
      const T = '0x' + '00'.repeat(31) + 'd0'; // any object id: these requests never reach the chain
      print('1. unsigned request', await call('POST', '/api/agent/attest', { action: 'enter-drop', target: T }));
      const good = await agentkitHeader([`urn:scalpless:attest:enter-drop:${T}`]);
      const tampered = Buffer.from(JSON.stringify({ ...good.payload, nonce: good.payload.nonce + 'ff' })).toString('base64');
      print('2. tampered signature', await call('POST', '/api/agent/attest', { action: 'enter-drop', target: T }, tampered));
      const stale = await agentkitHeader([`urn:scalpless:attest:enter-drop:${T}`], { issuedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
      print('3. 10-minute-old signature', await call('POST', '/api/agent/attest', { action: 'enter-drop', target: T }, stale.header));
      print('4. body action ≠ signed intent', await call('POST', '/api/agent/attest', { action: 'buy-resale', target: T }, (await agentkitHeader([`urn:scalpless:attest:enter-drop:${T}`])).header));
      print('5. non-delegable action (claim-win)', await signedCall('POST', '/api/agent/attest', { action: 'claim-win', target: T }, [`urn:scalpless:attest:claim-win:${T}`]));
      const once = await agentkitHeader([`urn:scalpless:attest:enter-drop:${T}`]);
      print('6a. valid request', await call('POST', '/api/agent/attest', { action: 'enter-drop', target: T }, once.header));
      print('6b. same request replayed', await call('POST', '/api/agent/attest', { action: 'enter-drop', target: T }, once.header));
      break;
    }
    default:
      console.log('commands: status | link <CODE> | me | attest <action> <OBJECT_ID> | enter <DROP_ID> | selftest');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
