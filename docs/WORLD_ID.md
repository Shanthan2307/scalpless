# World ID in Scalpless

Scalpless uses **World ID 4.0 (IDKit v4)** for humans and **World ID for Agents (AgentKit)** for the
AI agents that act for them. Nothing is simulated: every proof is checked by World's verify endpoint,
every agent request by its wallet signature plus a live AgentBook read on World Chain.

## Humans — IDKit v4

World ID 4.0 has two proof kinds, and Scalpless uses each for what it is designed for:

| Proof | Action | Repeatable? | Used for |
|---|---|---|---|
| **Uniqueness** | `WORLD_ACTION` (`scalpless-passport`) | **Once per human, ever** — World App returns `nullifier_replayed` afterwards | Registration. Its nullifier is the human key behind the Sui Credit Passport. World itself enforces "one passport per human". |
| **Session** | none | Yes; each proof has a single-use `session_nullifier` | Signing back in, and the fresh-liveness gate before claiming a win. |

**Flows**

- **Register** (two scans, once): `session/create` → `register`. The record
  `{ humanKey, nullifiers, tier, wallet, sessionId }` is written to `apps/backend/data/humans.json`
  *before* the response, because a lost uniqueness proof can never be re-issued.
- **Return / liveness** (one scan): `session/prove` against the saved `sessionId`.
- If a registration is interrupted after scan 1, the next attempt resumes at scan 2.

**Every proof is bound to the user's Sui wallet.** The backend issues a single-use challenge; the
IDKit signal is `<purpose>:<sui address>:<challenge>`, and the backend checks each response's
`signal_hash` against it before calling `POST https://developer.world.org/api/v4/verify/{rp_id}`.
A proof can't be replayed, reused for another purpose, or redirected to another wallet.

**Tiers come from the credentials World returns** (`enumerate` over the accepted credentials):
`proof_of_human` (Orb) → 3, `passport`/`mnc` → 2, `selfie` → 1.

**World ID → Sui.** Sui has no World ID verifier, so the backend is the attestation oracle: after a
verified proof it signs a BCS `AttestationPayload { nullifier, tier, action, sui address, amount,
expiry }` with Ed25519, and `registry::verify_attestation` checks it on-chain. The verifier key is
rotated with `pnpm rotate-verifier`.

**Code:** `apps/backend/src/services/world-id.service.ts`, `session.service.ts`,
`human-store.service.ts`, routes in `apps/backend/src/index.ts`;
`apps/web/src/components/world/WorldIdProvider.tsx` (the IDKit widgets).

## Agents — AgentKit

- The agent has an EVM key (its AgentKit identity, registered in **AgentBook** on World Chain with
  `npx @worldcoin/agentkit-cli register <address>`) and a Sui key (the address it executes from).
- Every request carries `x-agentkit-payload`: a base64 SIWE message signed EIP-191. The backend
  checks domain/uri, ≤ 5 min age, signature, a persisted nonce log (no replays), and
  `AgentBook.lookupHuman` on World Chain. **Unregistered agents are rejected — no fallback id.**
- The signed SIWE `resources` carry the intent (`urn:scalpless:attest:enter-drop`,
  `urn:scalpless:link:<code>:<sui address>`), so a request body can't be swapped.
- **Pairing:** AgentBook's human id and the Scalpless human key are unlinkable by design (different
  apps). A verified human creates a one-time link code in the web app; the agent claims it with a
  signed request. One AgentBook human ↔ one Scalpless human.
- **Human in the loop:** agents may only request `enter-drop` and `buy-resale`. Minting a passport
  and claiming a win require the human's own World ID proof.

**Code:** `apps/backend/src/services/agentkit.service.ts`, `scripts/agent.ts`,
`apps/web/src/components/world/AgentsPanel.tsx`.

```bash
pnpm agent status | link <CODE> | me | attest enter-drop | selftest
```

## Verified on 2026-09-26

- Real Orb registration (Tier 3, `proof_of_human`) and a Credit Passport minted on Sui testnet whose
  `world_nullifier` equals the World ID human key (tx `5P95JCGV1gQpevrEZ1iZQSB7GPQQnnr2CXTTLKNG3vtE`).
- Forged proofs reach World's verifier and are rejected; unbound signals, replayed challenges and
  replayed session proofs are rejected by the backend.
- Agent `0x926e…9CEf` registered in AgentBook, paired, and issued a delegated attestation; unsigned,
  tampered, stale, intent-mismatched, non-delegable and replayed requests are all rejected
  (`pnpm agent selftest`).

## Pitfalls we hit (and how the code handles them)

- **Uniqueness proofs are one-shot.** Using one as a "login" locked a user out once the cookie was
  gone. Registration is now persisted server-side and returning users use session proofs.
- **React Strict Mode + IDKit session widget.** Strict Mode runs effects twice in dev, creating the
  request twice with the same single-use `rp_context`; World App then shows "QR code expired".
  `reactStrictMode` is off in `apps/web/next.config.mjs`.
- **Chained widgets.** A finished step's widget can fire a late close event; each request has an id
  and stale events are ignored.
- **Session requests** are signed *without* an action (`signRequest({ signingKeyHex })`) and don't
  accept presets in IDKit ≥ 4.3 — use `constraints`.

## Borrowed from Proof-Of-Human-Drops

| Reference file | Scalpless equivalent | Change |
|---|---|---|
| `lib/worldid.service.ts` | `world-id.service.ts` | + session proofs, wallet-bound signal challenge, tiers from credentials |
| `lib/session.ts` | `session.service.ts` | Express instead of Next route handlers; session bound to a Sui wallet |
| `components/session-provider.tsx` | `WorldIdProvider.tsx` | two proof kinds, resumable registration, stale-event guard |
| `lib/agentkit-auth.ts` | `agentkit.service.ts` | no wallet-scoped fallback id; nonce log; signed intents |
| `lib/agentkit-client.ts` | `scripts/agent.ts` | same SIWE builder (hostname-only `domain`, origin-with-port `uri`) |
