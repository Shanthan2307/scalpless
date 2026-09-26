import express, { Request, Response, NextFunction } from 'express';
import { env } from './config/env';
import { attestationService } from './services/attestation.service';
import { createRequestContext, normalizeWallet, verifyProof, WorldIdError, TIER_NAMES, type Purpose } from './services/world-id.service';
import { getSession, setSession, clearSession, type SessionPayload } from './services/session.service';
import { humanStore, type HumanRecord } from './services/human-store.service';
import { authenticateAgent, requireIntent, AgentkitError } from './services/agentkit.service';
import { randomBytes } from 'crypto';

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

// Ed25519 attestation the Move registry verifies. Issued only to the verified human, only for
// the wallet their World ID proof was bound to.
app.post('/api/world/attest', async (req, res, next) => {
  try {
    const s = requireSession(req, res);
    if (!s) return;
    const { action, wallet, target } = req.body ?? {};
    if (!ATTESTABLE_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'BAD_ACTION', message: `action must be one of ${ATTESTABLE_ACTIONS.join(', ')}` });
    }
    if (typeof wallet !== 'string' || normalizeWallet(wallet) !== s.wallet) {
      return res.status(403).json({ error: 'WALLET_MISMATCH', message: 'Attestations are only issued to the wallet you verified with' });
    }
    if ((action as AttestableAction) === 'claim-win') {
      const age = Math.floor(Date.now() / 1000) - (s.livenessAt ?? 0);
      if (age > LIVENESS_WINDOW_SECONDS) {
        return res.status(403).json({ error: 'LIVENESS_REQUIRED', message: 'Re-verify with World ID to claim your win' });
      }
    }
    // The object the attestation may be spent on. Minting always targets the PassportRegistry;
    // delegation only to an agent this human paired.
    let targetAddr: string;
    if ((action as AttestableAction) === 'mint-credit-passport') {
      targetAddr = env.PASSPORT_REGISTRY_ID;
    } else {
      if (typeof target !== 'string') return res.status(400).json({ error: 'BAD_TARGET', message: 'target is required' });
      targetAddr = normalizeWallet(target);
      if ((action as AttestableAction) === 'delegate-agent' && !humanStore.agentsForHuman(s.humanKey).some((a) => a.suiAddress === targetAddr)) {
        return res.status(403).json({ error: 'AGENT_NOT_PAIRED', message: 'Pair this agent with a link code first' });
      }
    }
    const expiry_ms = Date.now() + ATTESTATION_TTL_MS;
    const attestation = await attestationService.signAttestation({
      human_key: s.humanKey,
      credential_tier: s.tier,
      action,
      target: targetAddr,
      subject: s.wallet,
      expiry_ms,
    });
    res.json({ action, target: targetAddr, credential_tier: s.tier, nullifier_hex: s.humanKey, wallet: s.wallet, attestation });
  } catch (err) {
    next(err);
  }
});

// ---- World ID for Agents (AgentKit) ---------------------------------------------------------
//
// A verified human pairs an AgentBook-registered agent: the human (World ID session) creates a
// one-time link code in the web app; the agent claims it with a signed AgentKit request. The agent
// then acts FOR that human — but only for delegable actions. Claiming a win still needs the human
// to re-verify in World App (human-in-the-loop).

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const linkCodes = new Map<string, { humanKey: string; expiresAt: number }>();
const AGENT_ACTIONS = ['enter-drop', 'buy-resale'] as const;

function agentView(a: { agentWallet: string; agentHumanId: string; suiAddress: string; linkedAt: number }) {
  return { agentWallet: a.agentWallet, agentHumanIdShort: shortKey(a.agentHumanId), suiAddress: a.suiAddress, linkedAt: a.linkedAt };
}

app.post('/api/world/agents/link-code', (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const now = Date.now();
  for (const [k, v] of linkCodes) if (v.expiresAt < now) linkCodes.delete(k);
  const code = randomBytes(4).toString('hex').toUpperCase();
  linkCodes.set(code, { humanKey: s.humanKey, expiresAt: now + LINK_CODE_TTL_MS });
  res.json({ code, expiresAt: now + LINK_CODE_TTL_MS });
});

app.get('/api/world/agents', (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  res.json({ agents: humanStore.agentsForHuman(s.humanKey).map(agentView) });
});

app.post('/api/world/agents/revoke', (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const ok = humanStore.unlinkAgent(s.humanKey, String(req.body?.agentWallet ?? ''));
  res.status(ok ? 200 : 404).json({ revoked: ok });
});

// Agent claims a link code. Signed intent: urn:scalpless:link:<CODE>:<sui address>
app.post('/api/agent/link', async (req, res, next) => {
  try {
    const agent = await authenticateAgent(req);
    const code = String(req.body?.code ?? '').toUpperCase();
    const suiAddress = normalizeWallet(String(req.body?.sui_address ?? ''));
    requireIntent(agent, `urn:scalpless:link:${code}:${suiAddress}`);
    const entry = linkCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(404).json({ error: 'LINK_CODE_INVALID', message: 'Link code is unknown or expired' });
    }
    linkCodes.delete(code);
    try {
      humanStore.linkAgent({ agentWallet: agent.wallet, agentHumanId: agent.agentHumanId, humanKey: entry.humanKey, suiAddress, linkedAt: Math.floor(Date.now() / 1000) });
    } catch (err) {
      return res.status(409).json({ error: 'LINK_REFUSED', message: (err as Error).message });
    }
    const human = humanStore.byHumanKey(entry.humanKey)!;
    res.json({ linked: true, acting_for: { humanKeyShort: shortKey(human.humanKey), tier: human.tier, tierName: TIER_NAMES[human.tier] } });
  } catch (err) {
    next(err);
  }
});

function requireLinkedAgent(agent: { wallet: string }) {
  const link = humanStore.agentByWallet(agent.wallet);
  if (!link) throw new AgentkitError('AGENT_NOT_LINKED', 'agent is not paired with a Scalpless human — ask them for a link code', 403);
  const human = humanStore.byHumanKey(link.humanKey);
  if (!human) throw new AgentkitError('AGENT_NOT_LINKED', 'paired human no longer exists', 403);
  return { link, human };
}

app.get('/api/agent/me', async (req, res, next) => {
  try {
    const agent = await authenticateAgent(req);
    const { link, human } = requireLinkedAgent(agent);
    res.json({ ...agentView(link), acting_for: { humanKeyShort: shortKey(human.humanKey), tier: human.tier, tierName: TIER_NAMES[human.tier] } });
  } catch (err) {
    next(err);
  }
});

// Attestation for a delegable action, issued for the agent's Sui address on the human's behalf.
// Signed intent: urn:scalpless:attest:<action>:<target object>
app.post('/api/agent/attest', async (req, res, next) => {
  try {
    const agent = await authenticateAgent(req);
    const action = String(req.body?.action ?? '');
    if (!(AGENT_ACTIONS as readonly string[]).includes(action)) {
      return res.status(403).json({ error: 'ACTION_NOT_DELEGABLE', message: `agents may only request: ${AGENT_ACTIONS.join(', ')}` });
    }
    const target = normalizeWallet(String(req.body?.target ?? ''));
    requireIntent(agent, `urn:scalpless:attest:${action}:${target}`);
    const { link, human } = requireLinkedAgent(agent);
    const expiry_ms = Date.now() + ATTESTATION_TTL_MS;
    const attestation = await attestationService.signAttestation({
      human_key: human.humanKey,
      credential_tier: human.tier,
      action,
      target,
      subject: link.suiAddress,
      expiry_ms,
    });
    res.json({ action, target, credential_tier: human.tier, nullifier_hex: human.humanKey, wallet: link.suiAddress, attestation });
  } catch (err) {
    next(err);
  }
});

// ---- errors ----------------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AgentkitError) {
    console.warn(`[agentkit] ${err.code}: ${err.message}`);
    return res.status(err.httpStatus).json({ error: err.code, message: err.message });
  }
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
