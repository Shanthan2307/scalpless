// World ID for Agents — per-request AgentKit authentication (ported from Proof-Of-Human-Drops
// lib/agentkit-auth.ts).
//
// Every agent request carries a base64 SIWE-style payload the agent signed with its wallet.
//   1. parseAgentkitHeader       → AgentkitPayload
//   2. validateAgentkitMessage   → domain/uri bind to THIS server, ≤ 5 min old, nonce unused
//   3. verifyAgentkitSignature   → recover the signing wallet (EIP-191 / ERC-1271)
//   4. AgentBook.lookupHuman     → anonymous human id on World Chain
// Unlike the reference, there is NO wallet-scoped fallback id: an agent that is not registered
// to a World ID-verified human in AgentBook is rejected.
import type { Request } from 'express';
import {
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  createAgentBookVerifier,
} from '@worldcoin/agentkit-core';
import { getAddress } from 'viem';
import { humanStore } from './human-store.service';

export const AGENTKIT_HEADER = 'x-agentkit-payload';
const MAX_AGE_MS = 5 * 60 * 1000;

export class AgentkitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 401,
  ) {
    super(message);
  }
}

export interface AgentIdentity {
  wallet: string; // checksummed
  agentHumanId: string; // AgentBook anonymous human id (hex)
  resources: string[]; // signed intent, e.g. "urn:scalpless:attest:enter-drop"
}

/** Require the signed SIWE resources to contain exactly this intent. */
export function requireIntent(agent: AgentIdentity, intent: string): void {
  if (!agent.resources.includes(intent)) {
    throw new AgentkitError('INTENT_NOT_SIGNED', `signed request does not authorize "${intent}"`, 403);
  }
}

const agentBook = createAgentBookVerifier({ rpcUrl: process.env.WORLD_CHAIN_RPC_URL || undefined });

// The public origin the agent addressed. Requests usually arrive via the Next.js /api proxy, which
// forwards the original host in x-forwarded-host; the SIWE domain/uri must match that origin.
export function resourceUriFromRequest(req: Request): string {
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  return `${proto}://${host}/`;
}

export async function authenticateAgent(req: Request): Promise<AgentIdentity> {
  const header = req.headers[AGENTKIT_HEADER];
  if (typeof header !== 'string' || !header.trim()) {
    throw new AgentkitError('MISSING_SIGNATURE', `missing ${AGENTKIT_HEADER} header`);
  }

  let payload;
  try {
    payload = parseAgentkitHeader(header.trim());
  } catch (err) {
    throw new AgentkitError('BAD_PAYLOAD', (err as Error).message);
  }

  const validation = await validateAgentkitMessage(payload, resourceUriFromRequest(req), { maxAge: MAX_AGE_MS });
  if (!validation.valid) throw new AgentkitError('MESSAGE_INVALID', validation.error ?? 'invalid AgentKit message');

  const verify = await verifyAgentkitSignature(payload, process.env.WORLD_CHAIN_RPC_URL || undefined);
  if (!verify.valid || !verify.address) {
    throw new AgentkitError('SIGNATURE_INVALID', verify.error?.split('\n')[0] ?? 'signature verification failed');
  }
  const wallet = getAddress(verify.address);

  // Replay protection — only after the signature is proven, so junk requests can't burn nonces.
  if (!humanStore.consumeAgentNonce(`${wallet}:${payload.nonce}`, MAX_AGE_MS * 2)) {
    throw new AgentkitError('NONCE_REPLAYED', 'this signed request was already used');
  }

  const agentHumanId = await agentBook.lookupHuman(wallet);
  if (!agentHumanId) {
    throw new AgentkitError(
      'AGENT_NOT_REGISTERED',
      `agent ${wallet} is not registered in AgentBook — run: npx @worldcoin/agentkit-cli register ${wallet}`,
      403,
    );
  }
  return { wallet, agentHumanId, resources: payload.resources ?? [] };
}
