import express, { Request, Response, NextFunction } from 'express';
import { env } from './config/env';
import { attestationService } from './services/attestation.service';
import { createRequestContext, normalizeWallet, verifyProof, WorldIdError, TIER_NAMES, type Purpose } from './services/world-id.service';
import { getSession, setSession, clearSession, type SessionPayload } from './services/session.service';
import { humanStore, type HumanRecord } from './services/human-store.service';

const app = express();
// The web app proxies /api/* to this server (apps/web/next.config.mjs), so the session cookie
// is first-party and no CORS is needed.
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - started}ms)`));
  next();
});

// Actions a verified human can get an attestation for. Each string is the exact action the
// Move module checks (claim.move: "claim-win", market.move: "buy-resale", ...).
const ATTESTABLE_ACTIONS = ['mint-credit-passport', 'enter-drop', 'claim-win', 'buy-resale', 'delegate-agent'] as const;
type AttestableAction = (typeof ATTESTABLE_ACTIONS)[number];
const LIVENESS_WINDOW_SECONDS = 10 * 60;
const ATTESTATION_TTL_MS = 15 * 60 * 1000;

const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

function publicSession(s: SessionPayload) {
  return {
    signedIn: true,
    humanKey: s.humanKey, // public on-chain once the passport is minted
    humanKeyShort: shortKey(s.humanKey),
    tier: s.tier,
    tierName: TIER_NAMES[s.tier],
    credentials: Object.keys(s.nullifiers),
    wallet: s.wallet,
    verifiedAt: s.verifiedAt,
    livenessAt: s.livenessAt,
  };
}

function requireSession(req: Request, res: Response): SessionPayload | null {
  const s = getSession(req);
  if (!s) {
    res.status(401).json({ error: 'NOT_VERIFIED', message: 'Verify with World ID first' });
    return null;
  }
  return s;
}

// ---- health / config -----------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', sui_network: env.SUI_NETWORK, package_id: env.PACKAGE_ID, verifier_pubkey: attestationService.getPublicKeyHex() });
});

app.get('/api/config', (_req, res) => {
  res.json({
    package_id: env.PACKAGE_ID,
    passport_registry_id: env.PASSPORT_REGISTRY_ID,
    registry_id: env.REGISTRY_OBJECT_ID,
    lending_pool_id: env.LENDING_POOL_OBJECT_ID,
    market_id: env.MARKET_OBJECT_ID,
    verifier_pubkey_hex: attestationService.getPublicKeyHex(),
    world_app_id: env.WORLD_APP_ID,
    world_action: env.WORLD_ACTION,
  });
});

// ---- World ID (IDKit v4) ---------------------------------------------------------------------
//
// Register (once per human):  session/create (scan 1) → register (scan 2, uniqueness proof)
// Return / liveness:          session/prove (repeatable)

// Session created in scan 1, waiting for the uniqueness proof of scan 2 (keyed by wallet).
const PENDING_TTL_MS = 30 * 60 * 1000;
const pendingSessions = new Map<string, { sessionId: `session_${string}`; expiresAt: number }>();

function startSession(res: Response, record: HumanRecord, livenessAt: number): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    humanKey: record.humanKey,
    nullifiers: record.nullifiers,
    tier: record.tier,
    wallet: record.wallet,
    verifiedAt: record.registeredAt,
    livenessAt,
  };
  setSession(res, payload);
  return { ...payload, iat: now, exp: now };
}

// Which World ID step this wallet needs next.
app.post('/api/world/status', (req, res) => {
  const wallet = normalizeWallet(String(req.body?.wallet ?? ''));
  const record = humanStore.byWallet(wallet);
  const pending = pendingSessions.get(wallet);
  res.json({ registered: !!record, pending: !!pending && pending.expiresAt > Date.now(), tier: record?.tier ?? null });
});

// Start a verification: signed rp_context + a wallet-bound, single-use signal challenge.
app.post('/api/world/rp-context', (req, res, next) => {
  try {
    const { purpose, wallet } = req.body ?? {};
    if (!['session-create', 'register', 'session-prove'].includes(purpose) || typeof wallet !== 'string') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'purpose and wallet are required' });
    }
    const w = normalizeWallet(wallet);
    const record = humanStore.byWallet(w);
    if (purpose !== 'session-prove' && record) {
      return res.status(409).json({ error: 'ALREADY_REGISTERED', message: 'This wallet already belongs to a verified human — sign in instead' });
    }
    if (purpose === 'register' && !pendingSessions.get(w)) {
      return res.status(409).json({ error: 'SESSION_FIRST', message: 'Create your World ID session first' });
    }
    res.json(createRequestContext(purpose as Purpose, w, record?.sessionId));
  } catch (err) {
    next(err);
  }
});

// Registration scan 1: World ID session (lets this human re-authenticate later).
app.post('/api/world/session/create', async (req, res, next) => {
  try {
    const proof = await verifyProof(req.body?.idkitResult, 'session-create');
    if (!humanStore.consumeSessionNullifiers(proof.sessionNullifiers!)) {
      return res.status(409).json({ error: 'PROOF_REPLAYED', message: 'This session proof was already used' });
    }
    pendingSessions.set(proof.wallet, { sessionId: proof.sessionId!, expiresAt: Date.now() + PENDING_TTL_MS });
    res.json({ step: 'register', tier: proof.tier });
  } catch (err) {
    next(err);
  }
});

// Registration scan 2: one-time uniqueness proof → the human key. Persisted before responding.
app.post('/api/world/register', async (req, res, next) => {
  try {
    const proof = await verifyProof(req.body?.idkitResult, 'register');
    const pending = pendingSessions.get(proof.wallet);
    if (!pending || pending.expiresAt < Date.now()) {
      return res.status(409).json({ error: 'SESSION_FIRST', message: 'World ID session expired — start again' });
    }
    if (humanStore.byHumanKey(proof.humanKey!)) {
      return res.status(409).json({ error: 'ALREADY_REGISTERED', message: 'This human is already registered with another wallet' });
    }
    const now = Math.floor(Date.now() / 1000);
    const record: HumanRecord = {
      humanKey: proof.humanKey!,
      nullifiers: proof.nullifiers!,
      tier: proof.tier,
      wallet: proof.wallet,
      sessionId: pending.sessionId,
      registeredAt: now,
    };
    humanStore.add(record);
    pendingSessions.delete(proof.wallet);
    res.json(publicSession(startSession(res, record, now)));
  } catch (err) {
    next(err);
  }
});

// Returning human / fresh liveness: prove the saved World ID session again.
app.post('/api/world/session/prove', async (req, res, next) => {
  try {
    const proof = await verifyProof(req.body?.idkitResult, 'session-prove');
    const record = humanStore.byWallet(proof.wallet);
    if (!record || record.sessionId !== proof.sessionId) {
      return res.status(403).json({ error: 'SESSION_MISMATCH', message: 'This World ID session does not belong to this wallet' });
    }
    if (!humanStore.consumeSessionNullifiers(proof.sessionNullifiers!)) {
      return res.status(409).json({ error: 'PROOF_REPLAYED', message: 'This session proof was already used' });
    }
    res.json(publicSession(startSession(res, record, Math.floor(Date.now() / 1000))));
  } catch (err) {
    next(err);
  }
});

app.get('/api/world/me', (req, res) => {
  const s = getSession(req);
  res.json(s ? publicSession(s) : { signedIn: false });
});

app.post('/api/world/signout', (_req, res) => {
  clearSession(res);
  res.json({ signedIn: false });
});

// ---- errors ----------------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof WorldIdError) {
    console.warn(`[world-id] ${err.code}: ${err.message}`, err.detail ? JSON.stringify(err.detail) : '');
    return res.status(err.httpStatus).json({ error: err.code, message: err.message });
  }
  console.error('[scalpless-backend]', err);
  res.status(500).json({ error: 'SERVER_ERROR', message: err instanceof Error ? err.message : 'unknown error' });
});

export const server = app.listen(env.PORT, () => {
  console.log(`[Scalpless Backend] Listening on port ${env.PORT}`);
  console.log(`[Scalpless Backend] Package ID: ${env.PACKAGE_ID}`);
  console.log(`[Scalpless Backend] Attestation pubkey: ${attestationService.getPublicKeyHex()}`);
  console.log(`[Scalpless Backend] World ID app ${env.WORLD_APP_ID} · rp ${env.WORLD_RP_ID} · action "${env.WORLD_ACTION}" · ${env.WORLD_ENVIRONMENT}`);
});

export default app;
