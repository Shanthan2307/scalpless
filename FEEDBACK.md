# World ID 4.0 & AgentKit — Builder Feedback

From integrating IDKit v4 (4.1.8 → 4.3.0) and AgentKit core 0.2.1 into Scalpless. Details in
`docs/WORLD_ID.md`.

## IDKit v4

- **What worked well:** `signRequest` + posting the `IDKitResult` verbatim to
  `/api/v4/verify/{rp_id}` is simple, and the per-credential results make tiering easy. The
  `enumerate` constraint is a great fit for "give me every credential you have".
- **Biggest surprise — uniqueness proofs are one-shot per human per action.** The first natural
  design ("sign in with an action proof, keep a cookie") permanently locked our tester out when the
  cookie was lost: World App answered `nullifier_replayed` forever. The docs should say prominently
  that uniqueness proofs are one-time and point returning-user flows to session proofs.
- **Session widget + React Strict Mode:** the dev-mode double effect creates the session request
  twice with the same `rp_context`, and World App only says "QR code expired". A dev warning or a
  guard in `useIDKitFlow` against reusing an `rp_context` would save hours.
- **Session proofs vs presets:** older examples use `createSession().preset(selfieCheck())`, while
  4.3.0 throws "Presets are not supported for session flows". The session-proofs page could show the
  `constraints` form.
- **Linking a session to a uniqueness nullifier** isn't possible cryptographically; we bind both to
  the same wallet-bound challenge flow and persist the pair. A documented pattern would help.
- **No Sui verifier:** we verify on the backend and sign an Ed25519 attestation that Move checks.
  A native World ID verifier on Sui would remove that trust point.

## AgentKit

- **What worked well:** the core primitives (`parseAgentkitHeader`, `validateAgentkitMessage`,
  `verifyAgentkitSignature`, `createAgentBookVerifier`) compose cleanly; registration via
  `npx @worldcoin/agentkit-cli register` took a minute and is gasless.
- **`domain` vs `uri`:** `domain` must be the hostname without port while `uri` keeps the port — easy
  to get wrong; worth calling out in the docs.
- **Intent binding:** the signed message proves *who* is calling, not *what* they asked for. We put
  the intent in SIWE `resources`; a documented convention would make this interoperable.
- **Linking an AgentBook human to an app's World ID human** is unlinkable by design, so apps need a
  pairing step. Guidance on the recommended pattern would help.
