'use client';

// World ID for the whole app (adapted from Proof-Of-Human-Drops components/session-provider.tsx,
// extended for World ID 4.0's two proof kinds). This provider owns the IDKit widgets:
//   signIn()          — new human: session proof (scan 1) + one-time uniqueness proof (scan 2);
//                       returning human: one repeatable session proof
//   verifyLiveness()  — session proof again (winner claim gate); must be the same human
//   attest(action)    — fetch the backend's Ed25519 attestation the Move contracts verify
// Every call resolves only after World ID + our backend both succeed; there is no mock path.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  IDKitRequestWidget,
  IDKitSessionWidget,
  CredentialRequest,
  setDebug,
  enumerate,
  type CredentialType,
  type IDKitResult,
  type RpContext,
} from '@worldcoin/idkit';

type Purpose = 'session-create' | 'register' | 'session-prove';
export type Phase = 'idle' | 'preparing' | 'verifying' | 'submitting';
export type AttestAction = 'mint-credit-passport' | 'enter-drop' | 'claim-win' | 'buy-resale' | 'delegate-agent';

export interface WorldSession {
  signedIn: true;
  humanKey: string;
  humanKeyShort: string;
  tier: 1 | 2 | 3;
  tierName: string;
  credentials: string[];
  wallet: string;
  verifiedAt: number;
  livenessAt: number | null;
}

export interface Attestation {
  action: AttestAction;
  target: string;
  credential_tier: number;
  nullifier_hex: string;
  wallet: string;
  attestation: {
    signatureHex: string;
    signatureBytes: number[];
    payloadBytes: number[];
    verifierPubkeyHex: string;
    expiry_ms: string;
  };
}

interface RequestContext {
  id: number; // local request number — events from an older widget are ignored
  purpose: Purpose;
  kind: 'uniqueness' | 'session';
  app_id: `app_${string}`;
  action?: string;
  action_description: string;
  existing_session_id?: `session_${string}`;
  environment: 'production' | 'staging';
  credentials: CredentialType[];
  signal: string;
  rp_context: RpContext;
}

const ENDPOINT: Record<Purpose, string> = {
  'session-create': '/api/world/session/create',
  register: '/api/world/register',
  'session-prove': '/api/world/session/prove',
};

const STEP_LABEL: Record<Purpose, string> = {
  'session-create': 'Step 1 of 2 · scan to create your login session',
  register: 'Step 2 of 2 · scan the NEW code to prove you are unique',
  'session-prove': 'Confirm it is you in World App',
};

interface WorldIdState {
  session: WorldSession | null;
  // Session exists but was verified with a different wallet than the one connected now.
  walletMismatch: boolean;
  loading: boolean;
  phase: Phase;
  step: string;
  error: string;
  signIn: () => Promise<boolean>;
  verifyLiveness: () => Promise<boolean>;
  attest: (action: AttestAction, target?: string) => Promise<Attestation>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorldIdState | null>(null);

// IDKit's own flow logging (status changes, bridge errors) — development only.
if (process.env.NODE_ENV !== 'production') setDebug(true);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `request failed (${res.status})`);
  return data as T;
}

const IDKIT_ERRORS: Record<string, string> = {
  user_rejected: 'You declined the request in World App',
  credential_unavailable: 'Your World ID has none of the credentials Scalpless accepts',
  nullifier_replayed: 'World ID already issued this one-time proof — if registration did not finish, tell the Scalpless team',
  max_verifications_reached: 'World ID verification limit reached for this action',
  rp_signature_expired: 'The request expired — try again',
  connection_failed: 'Could not reach World App',
};

export function WorldIdProvider({ children }: { children: ReactNode }) {
  const account = useCurrentAccount();
  const [session, setSession] = useState<WorldSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<RequestContext | null>(null);
  // Bridges IDKit's callback API to an awaitable promise.
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  // Set once IDKit hands us a proof, so the widget auto-closing isn't mistaken for a cancel.
  const proofReceivedRef = useRef(false);
  // Id of the request currently on screen. A finished step's widget can still fire a late
  // close event while the next step's widget is open; those stale events must not close it.
  const activeIdRef = useRef(0);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(ok);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api<WorldSession | { signedIn: false }>('/api/world/me');
      setSession(me.signedIn ? me : null);
    } catch {
      // backend unreachable — keep current state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const walletMismatch = !!(session && account && normalizeSuiAddress(account.address) !== session.wallet);

  // One World App round-trip for `purpose`; resolves true once our backend accepted the proof.
  const run = useCallback(
    async (purpose: Purpose): Promise<boolean> => {
      if (!account) {
        setError('Connect a Sui wallet first — your World ID proof is bound to it');
        return false;
      }
      if (resolverRef.current) return false; // a verification is already in flight
      setError('');
      setStep(STEP_LABEL[purpose]);
      proofReceivedRef.current = false;
      setPhase('preparing');
      const done = new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
      });
      try {
        const ctx = await api<Omit<RequestContext, 'id'>>('/api/world/rp-context', { purpose, wallet: account.address });
        const id = ++activeIdRef.current;
        setConfig({ ...ctx, id });
        setPhase('verifying');
        setOpen(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not start World ID');
        setPhase('idle');
        settle(false);
      }
      return done;
    },
    [account, settle],
  );

  const onProof = useCallback(
    async (result: IDKitResult) => {
      if (!config || config.id !== activeIdRef.current) return;
      proofReceivedRef.current = true;
      setOpen(false);
      setPhase('submitting');
      try {
        const res = await api<WorldSession | { step: string }>(ENDPOINT[config.purpose], { idkitResult: result });
        if ('signedIn' in res) setSession(res);
        setPhase('idle');
        settle(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'World ID verification failed');
        setPhase('idle');
        settle(false);
      }
    },
    [config, settle],
  );

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!account) {
      setError('Connect a Sui wallet first — your World ID proof is bound to it');
      return false;
    }
    try {
      const status = await api<{ registered: boolean; pending: boolean }>('/api/world/status', { wallet: account.address });
      if (status.registered) return run('session-prove');
      // Step 1 already done (e.g. the page was interrupted) → resume at step 2.
      if (status.pending) return run('register');
      return (await run('session-create')) && (await run('register'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not start World ID');
      return false;
    } finally {
      setStep('');
    }
  }, [account, run]);

  const verifyLiveness = useCallback(async () => {
    const ok = await run('session-prove');
    setStep('');
    return ok;
  }, [run]);

  const attest = useCallback(
    async (action: AttestAction, target?: string) => {
      if (!account) throw new Error('Connect your Sui wallet');
      return api<Attestation>('/api/world/attest', { action, wallet: account.address, target });
    },
    [account],
  );

  const signOut = useCallback(async () => {
    await api('/api/world/signout', {});
    setSession(null);
  }, []);

  const widgetShared = config && {
    open,
    onOpenChange: (o: boolean) => {
      if (config.id !== activeIdRef.current) return; // stale widget from a finished step
      setOpen(o);
      // Closed before a proof arrived → cancelled.
      if (!o && !proofReceivedRef.current) {
        console.info('[World ID] widget closed before a proof arrived', { purpose: config.purpose });
        setPhase('idle');
        settle(false);
      }
    },
    app_id: config.app_id,
    action_description: config.action_description,
    rp_context: config.rp_context,
    environment: config.environment,
    constraints: enumerate(...config.credentials.map((c) => CredentialRequest(c, { signal: config.signal }))),
    onSuccess: onProof,
    onError: (code: string) => {
      if (config.id !== activeIdRef.current) return;
      console.warn('[World ID] IDKit error:', code, { purpose: config.purpose });
      setError(IDKIT_ERRORS[code] ?? `World ID error: ${code}`);
      setPhase('idle');
      settle(false);
    },
  };

  return (
    <Ctx.Provider value={{ session, walletMismatch, loading, phase, step, error, signIn, verifyLiveness, attest, signOut, refresh }}>
      {children}
      {widgetShared && config.kind === 'uniqueness' && (
        <IDKitRequestWidget key={config.signal} {...widgetShared} action={config.action!} allow_legacy_proofs={true} />
      )}
      {widgetShared && config.kind === 'session' && (
        <IDKitSessionWidget
          key={config.signal}
          {...widgetShared}
          onSuccess={(r) => onProof(r)}
          {...(config.existing_session_id ? { existing_session_id: config.existing_session_id } : {})}
        />
      )}
    </Ctx.Provider>
  );
}

export function useWorldId(): WorldIdState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWorldId must be used within <WorldIdProvider>');
  return ctx;
}
