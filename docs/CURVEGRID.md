# Curvegrid MultiBaas in Scalpless

Scalpless tokenizes the right to buy one unit of a merchant's Shopify inventory. The token — a
key-only `Claim` object — lives on Sui. **Curvegrid MultiBaas** runs the EVM side of the
real-world-asset record: a public ledger on Base Sepolia that follows every claim from drop to
doorstep, indexes it, and feeds the merchant dashboard, the Shopify fulfilment loop and the AI
underwriting agent.

## Tracks

- **Best RWA Tokenization** — each claim is a tokenized, non-transferable right to a specific Shopify
  product variant; its lifecycle (won → paid / layaway / financed → resold → redeemed → shipped) is
  recorded on the MultiBaas-managed ledger and redemption creates the real Shopify order.
- **Best AI Agent Project** — a policy-aware underwriting agent (Gemini) that reads the borrower's
  on-chain passport and their credit history indexed by MultiBaas, and writes loan terms on-chain;
  plus a keeper agent that enforces repayment schedules on-chain and explains each action.
- (Also serves the dashboard use case: the 06 / Merchant tab.)

## How MultiBaas is used

| MultiBaas feature | Where |
|---|---|
| **Contract library** — ABI + bytecode of `ScalplessRWALedger` uploaded as `scalpless_rwa_ledger` v1.0 | `scripts/deploy-ledger.ts` |
| **Transaction building** — `deployContract` / `callContractFunction` return unsigned txs; the operator key signs; `submitSignedTransaction` submits | `apps/backend/src/services/multibaas.service.ts` |
| **Address aliases + linking** — `scalpless_ledger` alias linked to the contract from its deploy block | `scripts/deploy-ledger.ts` |
| **Event indexing** — `listEvents` (paged) serves claim timelines, the merchant dashboard and the agent's credit history | `/api/ledger/*` in `apps/backend/src/index.ts`, `underwriting.service.ts` |

Deployment: `packages/evm-contracts/deployments.base-sepolia.json` — ledger
`0xA15b03D31F32c8Da244d972121DF6f1091c66110` (Base Sepolia, chain 84532).

## Data flow

```
Sui events (GraphQL, cursor-paged)
   └─ mirror.service ── recordStage / recordCredit / listDrop / recordRedeemed ──▶ MultiBaas ──▶ ScalplessRWALedger (Base Sepolia)
                                                                                        │
Shopify Admin API ◀── redeemed claim → paid order ◀── redemption.service                 │ indexed events
Shopify order fulfilled ──▶ recordShipped ──────────────────────────────────────────────┘
MultiBaas listEvents ──▶ claim timelines · 06 / Merchant dashboard · underwriting agent
```

- `ScalplessRWALedger` (`packages/evm-contracts`, 5 Foundry tests) stores per drop the Shopify
  variant, and per claim the stage, holder, Shopify order and tracking; emits `DropListed`,
  `ClaimStageChanged`, `ClaimRedeemed`, `ClaimShipped`, `CreditEvent`. Only the operator writes.
- The mirror advances its cursor after every recorded event, so a failed write (e.g. no gas) is
  retried and nothing is recorded twice.

## Shopify

A Dev Dashboard app (client credentials → short-lived Admin API token, refreshed automatically):

1. **Launch** — the merchant picks a product variant in 06 / Merchant; Scalpless creates the Sui drop,
   tags the product `scalpless-drop`, adds "Enter the fair drop on Scalpless →" to its page, and the
   ledger records the variant.
2. **Redeem** — the holder of a paid claim enters a shipping address and burns the claim
   (`redeem::redeem`); the backend creates a paid Shopify order for that variant (inventory
   decremented) and the ledger records the order id.
3. **Ship** — when the merchant fulfils the order in Shopify admin, polling marks the delivery
   shipped with tracking, in Scalpless and on the ledger.

## AI agents (Gemini, structured output)

- **Underwriting** — the written policy sets a ceiling on principal and a floor on the fee; Gemini
  reviews the passport and the MultiBaas credit history and proposes terms; the result is clamped so
  the model can only tighten; terms + memo hash go on-chain (`lending::set_terms`). If Gemini is
  unavailable the policy decision is used and the memo says so.
- **Keeper** — acts only when the contract's own preconditions have passed (missed installment +
  grace, term + grace, overdue layaway); Gemini writes each action's reason; preview mode shows what
  it would do. Off by default (`KEEPER_AUTORUN=true` to run every minute).

## Verified (2026-09-26)

- Ledger deployed through MultiBaas (`0x769b08de…` deploy tx), aliased, linked; the mirror replayed
  the existing Sui history (drops, a won → liveness-verified → financed claim, loan opened / repaid /
  closed), readable back through MultiBaas event indexing.
- Shopify: a Sui drop linked to "The Collection Snowboard: Liquid" — product tagged, storefront link
  added, ledger records the variant.
- Gemini underwriting on a late-payer profile tightened terms (0.5 SUI cap vs 1 SUI policy, 22% vs
  8% fee) with a factual memo.
