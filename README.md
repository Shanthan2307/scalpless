# Scalpless - One human, one fair chance

Scalpless is a Web3 platform built for ETHGlobal, ensuring fair access to Real World Assets (RWAs), equitable drops, and under-collateralized lending.

## Bounties & Tracks

### 1. World ($10,000)
- **Best Use of IDKit:** World ID 4.0 via IDKit v4. A one-time uniqueness proof registers each human (World itself guarantees one Credit Passport per person); repeatable session proofs handle sign-in and the fresh-liveness check before claiming a win. Every proof is bound to the user's Sui wallet and verified with World's v4 API; tiers come from the credentials World returns (Orb, passport, selfie).
- **Best Use of World ID for Agents:** AgentKit agents registered in AgentBook pair with a verified human and enter drops or buy resales on their behalf. Every request is signature-checked, replay-protected and resolved against AgentBook on World Chain; claiming a win stays human-only.
- Details: `docs/WORLD_ID.md`. Feedback: `FEEDBACK.md`.

### 2. Sui ($5,000)
- **DeFi & Payments:** native SUI throughout. A human-keyed Credit Passport registry, fair drops drawn with `sui::random`, key-only RWA claims held by the protocol via transfer-to-object during layaway and resale, and an uncollateralized "borrow on yourself" lending pool with `SENIOR_LP` / `JUNIOR_LP` coins, on-chain underwriting terms, installment repayment, resale proceeds routed to the loan, and permissionless late/default enforcement (junior first-loss, network-wide lock-out).
- World ID attestations are verified on-chain and consumed as a hot potato for one action on one object in the same PTB.
- 22 Move tests; deployed to testnet (`packages/sui-contracts/deployments/testnet.json`). Details: `docs/SUI.md`.

### 3. Curvegrid ($3,000)
**1. Description of the project.** Scalpless is a fair-launch layer for hype products sold on Shopify: one World ID-verified human gets one entry, winners are drawn with Sui's on-chain randomness, and each win is a tokenized, non-transferable claim on a real unit of the merchant's inventory that can be paid in full, in layaway, or with an uncollateralized "borrow on yourself" loan, resold at no more than 110%, and redeemed for delivery.

**2. How we used Curvegrid (MultiBaas).** MultiBaas manages the EVM side of the real-world-asset record — `ScalplessRWALedger` on Base Sepolia (`0xA15b03D31F32c8Da244d972121DF6f1091c66110`): we uploaded it to the MultiBaas contract library, deploy and call it through MultiBaas-built transactions signed by our operator, alias and link it, and read its indexed events for claim timelines, the merchant dashboard and the AI underwriting agent. A mirror records every claim step and credit event from Sui on the ledger, and redemptions/fulfilments from Shopify. Details: `docs/CURVEGRID.md`.

**3. Best RWA Tokenization.** Each claim is a tokenized right to one Shopify product variant; its full lifecycle — won, paid / layaway / financed, resold, redeemed (a paid Shopify order is created), shipped (when the merchant fulfils) — is recorded on the MultiBaas-managed ledger.

**4. Best Digital Asset Dashboard.** The 06 / Merchant tab: Shopify products → linked drops, verified-human demand, winners and waitlist, and claims by lifecycle stage from MultiBaas' event index; deliveries with order and tracking in 03 / Claims.

**5. Best AI Agent Project.** A policy-aware underwriting agent (Gemini, structured output) reads the borrower's on-chain Credit Passport and their MultiBaas-indexed credit history and writes loan terms on-chain — it can only tighten the written policy. A keeper agent enforces repayment schedules on-chain (mark late / default, default layaways) and explains each action.

**Team, setup and testing:** see Getting Started below.

## Getting Started

```bash
pnpm install
cp .env.example .env        # fill in World ID, Sui, MultiBaas, Gemini and Shopify values
pnpm dev                    # backend :4000 + web :3000
```

- Move contracts: `cd packages/sui-contracts && sui move test` (24 tests) · deploy with `pnpm deploy:sui`
- EVM ledger: `cd packages/evm-contracts && forge test` (5 tests) · deploy through MultiBaas with `pnpm deploy:ledger`
- Agent CLI: `pnpm agent status | link <CODE> | me | enter <DROP_ID> | selftest`
- Docs: `docs/WORLD_ID.md`, `docs/SUI.md`, `docs/CURVEGRID.md`
