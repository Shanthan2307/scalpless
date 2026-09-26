// World ID v4 (managed RP) verification — the Sybil guarantee behind every Scalpless action.
// Ported from Proof-Of-Human-Drops lib/worldid.service.ts and extended for World ID 4.0's two
// proof kinds:
//
//   * UNIQUENESS proof (action = WORLD_ACTION): World App will produce it only ONCE per human per
//     action (`nullifier_replayed` afterwards). Used exactly once, at registration; its nullifier
//     is the human key behind the Sui Credit Passport.
//   * SESSION proof (no action): created once at registration, then provable any number of times
//     by the same human. Used to log back in and as the fresh-liveness gate before claiming a win.
//     Each proof carries a single-use session_nullifier.
//
// Every proof must also commit (via its signal) to a single-use challenge bound to the user's
// Sui wallet, so a proof can't be replayed or redirected to another wallet.
import { randomBytes } from 'crypto';
import { signRequest } from '@worldcoin/idkit/signing';
import { hashSignal } from '@worldcoin/idkit/hashing';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { env } from '../config/env';

export type CredentialTier = 1 | 2 | 3;
export type Purpose = 'session-create' | 'register' | 'session-prove';

const VERIFY_BASE = 'https://developer.world.org/api/v4/verify';
const CONTEXT_TTL_SECONDS = 300;

// Shown to the user inside World App, so a multi-scan registration is never confusing.
const DESCRIPTIONS: Record<Purpose, string> = {
  'session-create': 'Scalpless sign-up · step 1 of 2: create your login session',
  register: 'Scalpless sign-up · step 2 of 2: prove you are a unique human (one passport per person)',
  'session-prove': 'Scalpless · confirm it is you',
};

// Credential identifier → Scalpless tier (v4 identifiers, then legacy v3 ones).
const TIER_BY_CREDENTIAL: Record<string, CredentialTier> = {
  proof_of_human: 3,
  orb: 3,
  passport: 2,
  mnc: 2,
  document: 2,
  secure_document: 2,
  selfie: 1,
  device: 1,
};

// Precedence for choosing the primary human key when several credentials come back.
const KEY_PRECEDENCE = ['proof_of_human', 'orb', 'passport', 'mnc', 'secure_document', 'document', 'selfie', 'device'];

export const TIER_NAMES: Record<CredentialTier, string> = {
  1: 'Tier 1 · Selfie Check',
  2: 'Tier 2 · Passport / NFC document',
  3: 'Tier 3 · Orb Proof of Human',
};

export class WorldIdError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 422,
    public readonly detail?: unknown,
  ) {
    super(message);
  }
}

export function normalizeWallet(address: string): string {
  if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(address)) {
    throw new WorldIdError('BAD_WALLET', 'wallet must be a Sui address', 400);
  }
  return normalizeSuiAddress(address);
}

// ---- rp_context + challenge ------------------------------------------------------------------

interface Challenge {
  purpose: Purpose;
  wallet: string;
  signal: string;
  expectedSessionId?: string;
  expiresAt: number; // ms
}

// Challenges only live for one IDKit round-trip (≤ 5 min), so memory is the right store.
const challenges = new Map<string, Challenge>();

function pruneChallenges(now: number) {
  for (const [k, c] of challenges) if (c.expiresAt < now) challenges.delete(k);
}

export function createRequestContext(purpose: Purpose, walletInput: string, existingSessionId?: string) {
  const wallet = normalizeWallet(walletInput);
  if (purpose === 'session-prove' && !existingSessionId) {
    throw new WorldIdError('NO_SESSION', 'no World ID session on record for this wallet', 404);
  }
  const now = Date.now();
  pruneChallenges(now);

  const challenge = randomBytes(16).toString('hex');
  const signal = `${purpose}:${wallet}:${challenge}`;
  challenges.set(challenge, { purpose, wallet, signal, expectedSessionId: existingSessionId, expiresAt: now + CONTEXT_TTL_SECONDS * 1000 });

  // Uniqueness requests sign the action into the RP signature; session requests must not.
  const isUniqueness = purpose === 'register';
  const sig = signRequest({
    signingKeyHex: env.WORLD_RP_SIGNING_KEY,
    ...(isUniqueness ? { action: env.WORLD_ACTION } : {}),
    ttl: CONTEXT_TTL_SECONDS,
  });
  return {
    purpose,
    kind: isUniqueness ? ('uniqueness' as const) : ('session' as const),
    app_id: env.WORLD_APP_ID,
    action: isUniqueness ? env.WORLD_ACTION : undefined,
    action_description: DESCRIPTIONS[purpose],
    existing_session_id: existingSessionId,
    environment: env.WORLD_ENVIRONMENT,
    credentials: env.WORLD_CREDENTIALS,
    signal,
    rp_context: {
      rp_id: env.WORLD_RP_ID,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
    },
  };
}

// ---- verification ----------------------------------------------------------------------------

interface ResponseItem {
  identifier?: string;
  nullifier?: string; // uniqueness proofs
  session_nullifier?: string[]; // session proofs: [nullifier, generated action]
  signal_hash?: string;
}

interface VerifyResponse {
  success?: boolean;
  results?: Array<{ identifier: string; success: boolean; nullifier?: string; code?: string; detail?: string }>;
  code?: string;
  detail?: string;
  message?: string;
}

export interface VerifiedProof {
  wallet: string;
  tier: CredentialTier;
  credentials: string[];
  // uniqueness proofs
  humanKey?: string;
  nullifiers?: Record<string, string>;
  // session proofs
  sessionId?: `session_${string}`;
  sessionNullifiers?: string[];
}

async function callVerifyEndpoint(idkitResult: unknown): Promise<VerifyResponse> {
  const res = await fetch(`${VERIFY_BASE}/${env.WORLD_RP_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(idkitResult),
  });
  let body: VerifyResponse;
  try {
    body = (await res.json()) as VerifyResponse;
  } catch {
    throw new WorldIdError('VERIFY_UNAVAILABLE', `World verify endpoint returned non-JSON (HTTP ${res.status})`, 502);
  }
  if (!res.ok || body.success !== true) {
    throw new WorldIdError(
      body.code?.toUpperCase() || 'INVALID_PROOF',
      body.detail || body.message || `World ID verification failed (HTTP ${res.status})`,
      422,
      body,
    );
  }
  return body;
}

/**
 * Verify an IDKitResult against a challenge we issued for `purpose`. Throws WorldIdError on any
 * failure — there is no bypass path: an unverifiable proof is always a rejection.
 */
export async function verifyProof(idkitResult: unknown, purpose: Purpose): Promise<VerifiedProof> {
  if (typeof idkitResult !== 'object' || idkitResult === null) {
    throw new WorldIdError('BAD_REQUEST', 'idkitResult is required', 400);
  }
  const result = idkitResult as { action?: string; session_id?: `session_${string}`; responses?: ResponseItem[] };
  const isSession = purpose !== 'register';

  if (isSession && !result.session_id) throw new WorldIdError('WRONG_PROOF_TYPE', 'expected a World ID session proof');
  if (!isSession && result.session_id) throw new WorldIdError('WRONG_PROOF_TYPE', 'expected a World ID uniqueness proof');
  if (!isSession && result.action !== env.WORLD_ACTION) throw new WorldIdError('WRONG_ACTION', 'proof is not for the Scalpless action');
  const responses = Array.isArray(result.responses) ? result.responses : [];
  if (responses.length === 0) throw new WorldIdError('EMPTY_PROOF', 'proof contains no credentials');

  // Every credential in the proof must commit to one of OUR live challenges for this purpose.
  const signalHashes = new Set(responses.map((r) => r.signal_hash?.toLowerCase()));
  if (signalHashes.size !== 1 || signalHashes.has(undefined)) {
    throw new WorldIdError('SIGNAL_MISMATCH', 'proof is not bound to a Scalpless challenge');
  }
  const [signalHash] = [...signalHashes] as string[];
  pruneChallenges(Date.now());
  const entry = [...challenges.entries()].find(
    ([, c]) => c.purpose === purpose && hashSignal(c.signal).toLowerCase() === signalHash,
  );
  if (!entry) throw new WorldIdError('CHALLENGE_EXPIRED', 'proof challenge is unknown, expired, or already used');
  const [challengeId, challenge] = entry;
  challenges.delete(challengeId); // single use, even if World rejects the proof below

  if (purpose === 'session-prove' && result.session_id !== challenge.expectedSessionId) {
    throw new WorldIdError('SESSION_MISMATCH', 'this World ID session does not belong to this wallet', 403);
  }

  const verified = await callVerifyEndpoint(idkitResult);

  // Keep only credentials World confirmed (if it reports per credential).
  const confirmed = responses.filter((r) => {
    if (!r.identifier) return false;
    if (!verified.results) return true;
    return verified.results.some((x) => x.identifier === r.identifier && x.success);
  });
  const known = confirmed.filter((r) => TIER_BY_CREDENTIAL[r.identifier!]);
  if (known.length === 0) {
    throw new WorldIdError('NO_VALID_CREDENTIAL', `no supported credential confirmed (${responses.map((r) => r.identifier).join(', ')})`);
  }
  const tier = Math.max(...known.map((r) => TIER_BY_CREDENTIAL[r.identifier!])) as CredentialTier;
  const credentials = known.map((r) => r.identifier!);

  if (isSession) {
    const sessionNullifiers = known.map((r) => r.session_nullifier?.[0]?.toLowerCase()).filter((n): n is string => !!n);
    if (sessionNullifiers.length === 0) throw new WorldIdError('NO_SESSION_NULLIFIER', 'session proof has no session nullifier');
    return { wallet: challenge.wallet, tier, credentials, sessionId: result.session_id, sessionNullifiers };
  }

  const nullifiers: Record<string, string> = {};
  for (const r of known) {
    const perCredential = verified.results?.find((x) => x.identifier === r.identifier);
    const n = perCredential?.nullifier ?? r.nullifier;
    if (n) nullifiers[r.identifier!] = n.toLowerCase();
  }
  const primary = KEY_PRECEDENCE.find((id) => nullifiers[id]);
  if (!primary) throw new WorldIdError('NO_NULLIFIER', 'uniqueness proof has no nullifier');
  return { wallet: challenge.wallet, tier, credentials, humanKey: nullifiers[primary], nullifiers };
}
