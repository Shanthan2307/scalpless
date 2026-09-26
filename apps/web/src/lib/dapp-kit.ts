import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { NETWORK, SUI_RPC_URL } from './constants';

// gRPC client: Sui's public JSON-RPC is retired (browser calls to it fail CORS preflight), so the
// dApp kit builds, simulates and executes transactions over gRPC-web instead.
export const dAppKit = createDAppKit({
  networks: [NETWORK],
  defaultNetwork: NETWORK,
  autoConnect: true,
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: SUI_RPC_URL }),
});

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

// Sign with the connected wallet, execute over gRPC, and turn an on-chain failure (e.g. a Move
// abort) into a thrown error so callers never mistake a failed transaction for success.
export async function signAndExecute(transaction: Parameters<typeof dAppKit.signAndExecuteTransaction>[0]['transaction']) {
  const result = await dAppKit.signAndExecuteTransaction({ transaction });
  if (result.$kind === 'FailedTransaction') {
    const status = result.FailedTransaction.status;
    throw new Error(`Transaction ${result.FailedTransaction.digest} failed: ${status.error?.message ?? 'unknown error'}`);
  }
  return result.Transaction;
}
