// Curvegrid MultiBaas: contract management, transaction building/submission and event indexing
// for the ScalplessRWALedger on Base Sepolia.
//
// Write path: MultiBaas builds the unsigned call (callContractFunction), our operator key signs it
// (viem), MultiBaas submits it (submitSignedTransaction), and we wait for the receipt.
// Read path: MultiBaas indexes the ledger's events (listEvents), which feed the claim timelines,
// the merchant dashboard and the underwriting agent.
import {
  Configuration,
  ChainsApi,
  ContractsApi,
  EventsApi,
  type TransactionToSignTx,
} from '@curvegrid/multibaas-sdk';
import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const LEDGER_LABEL = 'scalpless_rwa_ledger';
export const LEDGER_ALIAS = 'scalpless_ledger';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[env] ${name} is not set`);
  return v;
}

let cached: { contracts: ContractsApi; events: EventsApi; chains: ChainsApi } | null = null;
export function mb() {
  if (!cached) {
    const config = new Configuration({ basePath: `${need('MULTIBAAS_URL').replace(/\/$/, '')}/api/v0`, accessToken: need('MULTIBAAS_API_KEY') });
    cached = { contracts: new ContractsApi(config), events: new EventsApi(config), chains: new ChainsApi(config) };
  }
  return cached;
}

export const operator = () => privateKeyToAccount(need('EVM_OPERATOR_PRIVATE_KEY') as Hex);
export const baseClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || undefined) });

/** Sign a MultiBaas-built transaction with the operator key, submit it through MultiBaas, await the receipt. */
export async function signAndSubmit(tx: TransactionToSignTx) {
  const account = operator();
  const signedTx = await account.signTransaction({
    chainId: baseSepolia.id,
    type: 'eip1559',
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.gasFeeCap ?? tx.gasPrice ?? 0),
    maxPriorityFeePerGas: BigInt(tx.gasTipCap ?? 0),
    to: (tx.to ?? undefined) as Hex | undefined,
    value: BigInt(tx.value || 0),
    data: tx.data as Hex,
  });
  await mb().chains.submitSignedTransaction({ signedTx });
  const hash = keccak256(signedTx);
  const receipt = await baseClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Base Sepolia tx ${hash} reverted`);
  return receipt;
}

/** Call a ledger function through MultiBaas (built by MultiBaas, signed by the operator). */
export async function ledgerCall(method: string, args: unknown[]) {
  const res = await mb().contracts.callContractFunction(LEDGER_ALIAS, LEDGER_LABEL, method, { args, from: operator().address });
  const result = res.data.result as { kind: string; tx?: TransactionToSignTx; output?: unknown };
  if (result.kind !== 'TransactionToSignResponse' || !result.tx) return result.output; // view call
  return signAndSubmit(result.tx);
}

export interface LedgerEvent {
  name: string;
  triggeredAt: string;
  txHash: string;
  inputs: Record<string, string>;
}

/** Ledger events indexed by MultiBaas, newest first (paged: MultiBaas caps a page at 50). */
export async function ledgerEvents(opts: { eventSignature?: string; max?: number } = {}): Promise<LedgerEvent[]> {
  const PAGE = 50;
  const out: LedgerEvent[] = [];
  for (let offset = 0; offset < (opts.max ?? 1000); offset += PAGE) {
    const res = await mb().events.listEvents(undefined, undefined, undefined, undefined, undefined, undefined, undefined, LEDGER_LABEL, opts.eventSignature, PAGE, offset);
    out.push(
      ...res.data.result.map((e) => ({
        name: e.event.name,
        triggeredAt: e.triggeredAt,
        txHash: e.transaction.txHash,
        inputs: Object.fromEntries(e.event.inputs.map((i) => [i.name, String(i.value)])),
      })),
    );
    if (res.data.result.length < PAGE) break;
  }
  return out;
}
