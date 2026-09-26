# Scalpless on Sui

Everything value-bearing in Scalpless is a Move object on Sui testnet: passports, drops, claims,
layaway plans, the lending pool and its LP coins. The web app reads them with Sui GraphQL and
writes them with programmable transaction blocks signed in the user's wallet (gRPC; the public
JSON-RPC endpoint is retired). Deployment IDs: `packages/sui-contracts/deployments/testnet.json`.

## Modules (`packages/sui-contracts/sources`)

| Module | What it does |
|---|---|
| `registry` | Verifies the backend's Ed25519 attestation of a World ID proof and returns an `Attested` hot potato (no abilities). Protocol functions `consume` it for **one action on one object** in the same transaction, so an attestation can't be replayed on another drop, claim or listing. |
| `passport` | Shared `PassportRegistry` keyed by the World ID human key: owner wallet + delegated agent addresses, tier, standing (Good / Late / Locked out), score, credit limit and history. Soulbound `PassportBadge` in the wallet. |
| `drop` | One entry per human (their wallet or a delegated agent), exact 10% deposit, three-round weighted draw with `sui::random` (tickets 1/3/6 by World ID tier, +1 after a loss). Losers are refunded in the draw transaction and shuffled onto a waitlist. |
| `claim` | The won right to buy the item. `key` without `store`: only the protocol can move it — no transfers to scalpers or outside marketplaces. Liveness check with a fresh World ID session proof before settling. |
| `settlement` | Pay in full, or zero-default layaway: the plan object holds the claim (transfer-to-object); a missed installment refunds 95% and passes the claim to the waitlist (anyone can trigger). Completing a layaway raises the credit limit. |
| `lending` | EthGlobal26's LoanRegistry + LoanVault + TranchePool + IncomeRouter in one shared pool (see below). |
| `senior_lp`, `junior_lp` | `SENIOR_LP` / `JUNIOR_LP` coins registered with the Sui coin registry; minted and burned only by the pool. |
| `market` | Resale capped at 110% of face value; the market object holds listed claims; buyers are verified humans, one resale per human per drop; proceeds repay the seller's loan first. |

## Lending: borrow on yourself

- **Lenders** deposit SUI into the senior or junior tranche and receive LP coins. Share value =
  tranche assets / LP supply; assets include money lent out. Withdrawals are limited to cash.
- **Underwriter** (`UnderwriterCap`, held by the backend operator) writes per-human terms with
  `set_terms`. The backend reads the passport and pool from chain, applies the published policy in
  `apps/backend/src/services/underwriting.service.ts`, and stores the SHA-256 of its memo on-chain.
- **Borrow:** the pool pays the drop's seller directly; the claim ships immediately. No collateral:
  the loan is backed by the borrower's World ID. Principal ≤ terms ≤ passport credit limit.
- **Repay:** 4 installments over the term; anyone can repay; resale proceeds and layaway refunds
  are routed to the loan first.
- **Enforcement (permissionless):** `mark_late` after an installment + grace, `mark_default` after
  term + grace. The junior tranche absorbs the loss first, and the human is locked out — no loans,
  no drops — on every wallet, because World ID issues them only one passport.
- Invariant, checked in tests: `senior_assets + junior_assets == cash + outstanding_principal`.
- Demo parameters: 10-minute loans (2.5-minute installments), 2-minute grace; drops set their own
  entry, claim and layaway windows (minimum 1 minute).

## World ID ↔ Sui

Sui has no World ID verifier, so the backend verifies proofs with World's v4 API and signs
`AttestationPayload { human_key, credential_tier, action, target, subject, amount, expiry_ms }`
(BCS, `packages/shared/src/bcs-payload.ts`). The `golden_signature_verifies` Move test checks a
signature produced by the TypeScript serializer, so the two layouts can't drift apart.

## Tests

```bash
cd packages/sui-contracts && sui move test
```

22 tests: passport uniqueness, attestation target/sender binding, one entry per human, tier from the
passport, agent entry on behalf of a human, the `sui::random` draw with refunds and waitlist, pay in
full, liveness gating, layaway completion and default-to-waitlist, borrow/repay with LP yield,
default with junior first-loss and lock-out, early-default rejection, the 110% cap, resale proceeds
repaying the seller's loan, and one resale per human per drop.

## Deploy

```bash
pnpm deploy:sui                          # publish + initialize (SUI_DEPLOYER_PRIVATE_KEY, ≥ 1 testnet SUI)
pnpm deploy:sui --from-publish <DIGEST>  # initialize an existing publish
pnpm rotate-verifier --execute           # after changing ATTESTATION_SIGNER_KEY
```

## Verified on testnet (2026-09-26)

- Package `0xe1494f19…a856` published (`F3ngknuNJc6zrudhTmCN8YGXQQfSq4ro1iGW69KKWZ2e`), initialized
  (`8Xs75DBzNABgKkgUTqHRUQywjVcGJPvsonS5UZxCiVVJ`).
- A real Orb-verified human minted a passport, entered a drop (6 tickets), won the `sui::random`
  draw, passed the liveness check with a World ID session proof, was underwritten on-chain and
  borrowed 0.45 SUI from the junior tranche to pay the seller; the claim is settled and the loan
  (0.4725 SUI) is outstanding.
- Listing at 111% of face value aborted on-chain (`market::EPriceExceedsFairCap`).
- An AgentBook-registered agent with a valid backend attestation was still refused by
  `passport::assert_acts_for` until the human delegates it on-chain.

## Borrowed from EthGlobal26 (Veritas)

| EthGlobal26 (Solidity, Arc/USDC) | Scalpless (Move, SUI) | Change |
|---|---|---|
| `PassportRegistry` (`passports[nullifier]`, `walletToHuman`, standing/score/limit ladder, `recordLateness/Default/FullRepayment`) | `passport` | Shared object + `Table`s; agents bound too; passport minted from a backend attestation instead of an on-chain World ID verifier |
| `LoanRegistry.setTerms` (Chainlink CRE forwarder only) | `lending::set_terms` (`UnderwriterCap`) | Backend underwriter; memo hash stored with the terms |
| `LoanVault.claim` / `repay` / `markLate` / `markDefault` (30 days, 4 installments, 3-day grace) | `lending::borrow_for_claim` / `repay` / `mark_late` / `mark_default` | Pays the drop seller directly; loans keyed by human, not wallet; demo-length term |
| `TranchePool` (share accounting, `absorbLoss`, separate `deployToVault`) | `lending::LendingPool` + `SENIOR_LP` / `JUNIOR_LP` coins | One pool: no admin step moving money to the vault; fees split to tranches on repayment |
| `IncomeRouter.onPayout` (mocked creator payouts) | `lending::route_income` | Real income: resale proceeds and layaway refunds |
| Chainlink price-feed `RateModel`, CCTP/Gateway, Noir circuits | — | Not used on Sui |
