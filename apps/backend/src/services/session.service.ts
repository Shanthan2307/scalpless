// World ID session cookie (ported from Proof-Of-Human-Drops lib/session.ts).
//
// After ONE verified World ID proof the human's nullifier (their stable, app-scoped human key)
// is kept in an HMAC-signed, httpOnly cookie, so later actions (mint passport, enter drop, buy
// resale) need no re-scan. The cookie is also bound to the Sui wallet the proof's signal
// committed to — attestations are only ever issued for that wallet.
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import type { CredentialTier } from './world-id.service';

export const SESSION_COOKIE = 'scalpless_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SessionPayload {
  // Primary nullifier (highest-precedence credential) — the human key used on-chain.
  humanKey: string;
  // Every credential nullifier World returned, by credential identifier.
  nullifiers: Record<string, string>;
  tier: CredentialTier;
  // Sui address the World ID proof's signal was bound to.
  wallet: string;
  verifiedAt: number; // unix seconds
  livenessAt: number | null; // unix seconds of the last fresh re-scan
  iat: number;
  exp: number;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(payloadB64).digest('base64url');
}

export function encodeSession(p: Omit<SessionPayload, 'iat' | 'exp'>): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { ...p, iat, exp: iat + SESSION_TTL_SECONDS };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${b64}.${sign(b64)}`;
}

export function decodeSession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(b64));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.humanKey || !payload.wallet) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function getSession(req: Request): SessionPayload | null {
  return decodeSession(readCookie(req, SESSION_COOKIE));
}

export function setSession(res: Response, p: Omit<SessionPayload, 'iat' | 'exp'>): void {
  res.cookie(SESSION_COOKIE, encodeSession(p), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
