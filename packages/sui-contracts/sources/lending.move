/// Human-backed, uncollateralized lending — EthGlobal26's LoanRegistry + LoanVault + TranchePool
/// + IncomeRouter, ported to one shared Sui object.
///
/// * Lenders deposit SUI into a senior or junior tranche and receive SENIOR_LP / JUNIOR_LP coins.
///   Share value = tranche assets / LP supply, where assets include money lent out.
/// * The underwriter (UnderwriterCap holder — the Scalpless underwriting agent) writes per-human
///   terms; a borrower can only draw within them and within their passport's credit limit.
/// * "Borrow on yourself": the pool pays the drop's seller directly; the claim ships at once and
///   nothing is locked as collateral. The loan is backed by the borrower's World ID identity.
/// * Repayment: 4 equal installments over `term_ms`. Anyone can repay for a borrower, and resale
///   proceeds / layaway refunds are routed to the loan first (`route_income`).
/// * Enforcement is permissionless: after an installment + grace period anyone can `mark_late`;
///   after the term + grace anyone can `mark_default` — the junior tranche absorbs the loss first
///   and the human is locked out of Scalpless on every wallet.
///
/// Invariant: senior_assets + junior_assets == cash + outstanding_principal.
module scalpless::lending;

use scalpless::claim::{Self, Claim};
use scalpless::drop::Drop;
use scalpless::junior_lp::JUNIOR_LP;
use scalpless::passport::PassportRegistry;
use scalpless::registry::AdminCap;
use scalpless::senior_lp::SENIOR_LP;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;
use sui::sui::SUI;
use sui::table::{Self, Table};

const BPS: u64 = 10_000;
const INSTALLMENTS: u64 = 4;
const MAX_FEE_BPS: u64 = 3_000;
const MIN_TERM_MS: u64 = 4 * 60_000;

const EZeroAmount: u64 = 0;
const EInsufficientLiquidity: u64 = 1;
const ENoTerms: u64 = 2;
const ETermsExpired: u64 = 3;
const EOverTerms: u64 = 4;
const EOverCreditLimit: u64 = 5;
const ELockedOut: u64 = 6;
const ENoLoan: u64 = 7;
const ENotBehind: u64 = 8;
const EGraceNotElapsed: u64 = 9;
const EAlreadyLate: u64 = 10;
const ETermNotElapsed: u64 = 11;
const EBadParams: u64 = 12;
const EWrongDrop: u64 = 13;
const ECapInUse: u64 = 14;

public struct UnderwriterCap has key, store { id: UID }

public struct LendingPool has key {
    id: UID,
    cash: Balance<SUI>,
    senior_assets: u64,
    junior_assets: u64,
    senior_cap: TreasuryCap<SENIOR_LP>,
    junior_cap: TreasuryCap<JUNIOR_LP>,
    /// Share of loan fees paid to the senior tranche; the junior tranche gets the rest.
    senior_fee_share_bps: u64,
    term_ms: u64,
    grace_ms: u64,
    outstanding_principal: u64,
    total_losses: u64,
    terms: Table<vector<u8>, Terms>,
    loans: Table<vector<u8>, Loan>,
}

/// Underwriter's decision for one human (EthGlobal26 LoanRegistry.Terms).
public struct Terms has drop, store {
    max_principal_mist: u64,
    fee_bps: u64,
    risk_band: u8,
    /// Hash of the underwriting memo kept off-chain.
    memo_hash: vector<u8>,
    expiry_ms: u64,
}

public struct Loan has drop, store {
    borrower: address,
    claim_id: ID,
    principal_mist: u64,
    fee_mist: u64,
    repaid_principal_mist: u64,
    repaid_fee_mist: u64,
    installment_mist: u64,
    started_ms: u64,
    late_marked: bool,
}

public struct Deposited has copy, drop { lender: address, senior: bool, amount_mist: u64, shares: u64 }
public struct Withdrawn has copy, drop { lender: address, senior: bool, amount_mist: u64, shares: u64 }
public struct TermsSet has copy, drop { human_key: vector<u8>, max_principal_mist: u64, fee_bps: u64, risk_band: u8, memo_hash: vector<u8>, expiry_ms: u64 }
public struct LoanOpened has copy, drop { human_key: vector<u8>, borrower: address, claim_id: ID, principal_mist: u64, fee_mist: u64, seller: address }
public struct Repaid has copy, drop { human_key: vector<u8>, principal_mist: u64, fee_mist: u64, remaining_mist: u64 }
public struct LoanClosed has copy, drop { human_key: vector<u8> }
public struct MarkedLate has copy, drop { human_key: vector<u8>, paid_mist: u64, expected_mist: u64 }
public struct Defaulted has copy, drop { human_key: vector<u8>, loss_mist: u64, from_junior_mist: u64, from_senior_mist: u64 }

public fun create_pool(
    _: &AdminCap,
    senior_cap: TreasuryCap<SENIOR_LP>,
    junior_cap: TreasuryCap<JUNIOR_LP>,
    senior_fee_share_bps: u64,
    term_ms: u64,
    grace_ms: u64,
    ctx: &mut TxContext,
): UnderwriterCap {
    assert!(senior_cap.total_supply() == 0 && junior_cap.total_supply() == 0, ECapInUse);
    assert!(senior_fee_share_bps <= BPS && term_ms >= MIN_TERM_MS, EBadParams);
    transfer::share_object(LendingPool {
        id: object::new(ctx),
        cash: balance::zero(),
        senior_assets: 0,
        junior_assets: 0,
        senior_cap,
        junior_cap,
        senior_fee_share_bps,
        term_ms,
        grace_ms,
        outstanding_principal: 0,
        total_losses: 0,
        terms: table::new(ctx),
        loans: table::new(ctx),
    });
    UnderwriterCap { id: object::new(ctx) }
}

// ---- lenders ------------------------------------------------------------------------------------

fun mul_div(a: u64, b: u64, c: u64): u64 { ((a as u128) * (b as u128) / (c as u128)) as u64 }

fun shares_for(amount: u64, supply: u64, assets: u64): u64 {
    if (supply == 0 || assets == 0) amount else mul_div(amount, supply, assets)
}

public fun deposit_senior(pool: &mut LendingPool, payment: Coin<SUI>, ctx: &mut TxContext): Coin<SENIOR_LP> {
    let amount = payment.value();
    assert!(amount > 0, EZeroAmount);
    let shares = shares_for(amount, pool.senior_cap.total_supply(), pool.senior_assets);
    pool.senior_assets = pool.senior_assets + amount;
    pool.cash.join(payment.into_balance());
    event::emit(Deposited { lender: ctx.sender(), senior: true, amount_mist: amount, shares });
    pool.senior_cap.mint(shares, ctx)
}

public fun deposit_junior(pool: &mut LendingPool, payment: Coin<SUI>, ctx: &mut TxContext): Coin<JUNIOR_LP> {
    let amount = payment.value();
    assert!(amount > 0, EZeroAmount);
    let shares = shares_for(amount, pool.junior_cap.total_supply(), pool.junior_assets);
    pool.junior_assets = pool.junior_assets + amount;
    pool.cash.join(payment.into_balance());
    event::emit(Deposited { lender: ctx.sender(), senior: false, amount_mist: amount, shares });
    pool.junior_cap.mint(shares, ctx)
}

/// Burn LP coins for their share of tranche assets. Limited by cash on hand (money lent out
/// comes back as borrowers repay).
public fun withdraw_senior(pool: &mut LendingPool, shares: Coin<SENIOR_LP>, ctx: &mut TxContext): Coin<SUI> {
    let n = shares.value();
    assert!(n > 0, EZeroAmount);
    let amount = mul_div(n, pool.senior_assets, pool.senior_cap.total_supply());
    assert!(pool.cash.value() >= amount, EInsufficientLiquidity);
    pool.senior_cap.burn(shares);
    pool.senior_assets = pool.senior_assets - amount;
    event::emit(Withdrawn { lender: ctx.sender(), senior: true, amount_mist: amount, shares: n });
    coin::take(&mut pool.cash, amount, ctx)
}

public fun withdraw_junior(pool: &mut LendingPool, shares: Coin<JUNIOR_LP>, ctx: &mut TxContext): Coin<SUI> {
    let n = shares.value();
    assert!(n > 0, EZeroAmount);
    let amount = mul_div(n, pool.junior_assets, pool.junior_cap.total_supply());
    assert!(pool.cash.value() >= amount, EInsufficientLiquidity);
    pool.junior_cap.burn(shares);
    pool.junior_assets = pool.junior_assets - amount;
    event::emit(Withdrawn { lender: ctx.sender(), senior: false, amount_mist: amount, shares: n });
    coin::take(&mut pool.cash, amount, ctx)
}

// ---- underwriting -------------------------------------------------------------------------------

public fun set_terms(
    _: &UnderwriterCap,
    pool: &mut LendingPool,
    human_key: vector<u8>,
    max_principal_mist: u64,
    fee_bps: u64,
    risk_band: u8,
    memo_hash: vector<u8>,
    expiry_ms: u64,
) {
    assert!(fee_bps <= MAX_FEE_BPS, EBadParams);
    if (pool.terms.contains(human_key)) { pool.terms.remove(human_key); };
    pool.terms.add(human_key, Terms { max_principal_mist, fee_bps, risk_band, memo_hash, expiry_ms });
    event::emit(TermsSet { human_key, max_principal_mist, fee_bps, risk_band, memo_hash, expiry_ms });
}

public fun set_params(_: &AdminCap, pool: &mut LendingPool, senior_fee_share_bps: u64, term_ms: u64, grace_ms: u64) {
    assert!(senior_fee_share_bps <= BPS && term_ms >= MIN_TERM_MS, EBadParams);
    pool.senior_fee_share_bps = senior_fee_share_bps;
    pool.term_ms = term_ms;
    pool.grace_ms = grace_ms;
}

// ---- borrowers ----------------------------------------------------------------------------------

/// Pay for a won claim with an uncollateralized loan: the pool pays the seller the rest of the
/// face price, the claim is settled and ships immediately.
public fun borrow_for_claim(
    pool: &mut LendingPool,
    drop: &mut Drop,
    claim: &mut Claim,
    preg: &mut PassportRegistry,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    claim.assert_holder(ctx);
    claim.assert_status(claim::status_liveness_verified());
    claim.assert_not_expired(clock);
    assert!(object::id(drop) == claim.drop_id(), EWrongDrop);
    let human_key = claim.human_key();
    assert!(!preg.is_locked_out(human_key), ELockedOut);

    assert!(pool.terms.contains(human_key), ENoTerms);
    let terms = pool.terms.remove(human_key);
    assert!(clock.timestamp_ms() <= terms.expiry_ms, ETermsExpired);
    let principal = claim.face_price_mist() - claim.deposit_mist();
    assert!(principal <= terms.max_principal_mist, EOverTerms);
    assert!(principal <= preg.credit_limit_mist(human_key), EOverCreditLimit);
    assert!(pool.cash.value() >= principal, EInsufficientLiquidity);
    preg.record_loan_opened(human_key);

    let mut payment = pool.cash.split(principal);
    payment.join(drop.take_deposit(claim.deposit_mist()));
    let seller = claim.seller();
    transfer::public_transfer(coin::from_balance(payment, ctx), seller);
    claim.clear_deposit();
    claim.set_status(claim::status_settled());

    let fee = mul_div(principal, terms.fee_bps, BPS);
    let total = principal + fee;
    pool.loans.add(human_key, Loan {
        borrower: ctx.sender(),
        claim_id: object::id(claim),
        principal_mist: principal,
        fee_mist: fee,
        repaid_principal_mist: 0,
        repaid_fee_mist: 0,
        installment_mist: (total + INSTALLMENTS - 1) / INSTALLMENTS,
        started_ms: clock.timestamp_ms(),
        late_marked: false,
    });
    pool.outstanding_principal = pool.outstanding_principal + principal;
    event::emit(LoanOpened { human_key, borrower: ctx.sender(), claim_id: object::id(claim), principal_mist: principal, fee_mist: fee, seller });
}

/// Apply up to what is owed from `funds`; principal first, then the fee (split between tranches).
fun apply_repayment(pool: &mut LendingPool, preg: &mut PassportRegistry, human_key: vector<u8>, funds: &mut Coin<SUI>) {
    if (!pool.loans.contains(human_key)) return;
    let (principal_due, fee_due) = {
        let loan = &pool.loans[human_key];
        (loan.principal_mist - loan.repaid_principal_mist, loan.fee_mist - loan.repaid_fee_mist)
    };
    let to_principal = funds.value().min(principal_due);
    pool.cash.join(funds.balance_mut().split(to_principal));
    pool.outstanding_principal = pool.outstanding_principal - to_principal;

    let to_fee = funds.value().min(fee_due);
    pool.cash.join(funds.balance_mut().split(to_fee));
    let senior_part = mul_div(to_fee, pool.senior_fee_share_bps, BPS);
    pool.senior_assets = pool.senior_assets + senior_part;
    pool.junior_assets = pool.junior_assets + (to_fee - senior_part);

    let loan = &mut pool.loans[human_key];
    loan.repaid_principal_mist = loan.repaid_principal_mist + to_principal;
    loan.repaid_fee_mist = loan.repaid_fee_mist + to_fee;
    let remaining = (loan.principal_mist - loan.repaid_principal_mist) + (loan.fee_mist - loan.repaid_fee_mist);
    event::emit(Repaid { human_key, principal_mist: to_principal, fee_mist: to_fee, remaining_mist: remaining });
    if (remaining == 0) {
        pool.loans.remove(human_key);
        preg.record_repayment(human_key);
        event::emit(LoanClosed { human_key });
    };
}

/// Repay (anyone may pay for a borrower). Returns the change.
public fun repay(
    pool: &mut LendingPool,
    preg: &mut PassportRegistry,
    human_key: vector<u8>,
    mut payment: Coin<SUI>,
): Coin<SUI> {
    assert!(pool.loans.contains(human_key), ENoLoan);
    apply_repayment(pool, preg, human_key, &mut payment);
    payment
}

/// IncomeRouter: money owed to a human first repays their loan; the rest goes to `recipient`.
public(package) fun route_income(
    pool: &mut LendingPool,
    preg: &mut PassportRegistry,
    human_key: vector<u8>,
    mut income: Coin<SUI>,
    recipient: address,
) {
    apply_repayment(pool, preg, human_key, &mut income);
    if (income.value() > 0) transfer::public_transfer(income, recipient) else income.destroy_zero();
}

// ---- permissionless enforcement -------------------------------------------------------------

public fun mark_late(pool: &mut LendingPool, preg: &mut PassportRegistry, human_key: vector<u8>, clock: &Clock) {
    assert!(pool.loans.contains(human_key), ENoLoan);
    let interval = pool.term_ms / INSTALLMENTS;
    let grace = pool.grace_ms;
    let loan = &mut pool.loans[human_key];
    assert!(!loan.late_marked, EAlreadyLate);
    let now = clock.timestamp_ms();
    let due_count = ((now - loan.started_ms) / interval).min(INSTALLMENTS);
    let expected = (due_count * loan.installment_mist).min(loan.principal_mist + loan.fee_mist);
    let paid = loan.repaid_principal_mist + loan.repaid_fee_mist;
    assert!(paid < expected, ENotBehind);
    assert!(now >= loan.started_ms + due_count * interval + grace, EGraceNotElapsed);
    loan.late_marked = true;
    preg.record_late(human_key);
    event::emit(MarkedLate { human_key, paid_mist: paid, expected_mist: expected });
}

public fun mark_default(pool: &mut LendingPool, preg: &mut PassportRegistry, human_key: vector<u8>, clock: &Clock) {
    assert!(pool.loans.contains(human_key), ENoLoan);
    let loan = pool.loans.remove(human_key);
    assert!(clock.timestamp_ms() >= loan.started_ms + pool.term_ms + pool.grace_ms, ETermNotElapsed);
    let loss = loan.principal_mist - loan.repaid_principal_mist;
    let from_junior = loss.min(pool.junior_assets);
    pool.junior_assets = pool.junior_assets - from_junior;
    let from_senior = (loss - from_junior).min(pool.senior_assets);
    pool.senior_assets = pool.senior_assets - from_senior;
    pool.outstanding_principal = pool.outstanding_principal - loss;
    pool.total_losses = pool.total_losses + loss;
    preg.record_default(human_key);
    event::emit(Defaulted { human_key, loss_mist: loss, from_junior_mist: from_junior, from_senior_mist: from_senior });
}

// ---- views ----------------------------------------------------------------------------------

public fun cash(pool: &LendingPool): u64 { pool.cash.value() }
public fun senior_assets(pool: &LendingPool): u64 { pool.senior_assets }
public fun junior_assets(pool: &LendingPool): u64 { pool.junior_assets }
public fun outstanding_principal(pool: &LendingPool): u64 { pool.outstanding_principal }
public fun total_losses(pool: &LendingPool): u64 { pool.total_losses }
public fun senior_supply(pool: &LendingPool): u64 { pool.senior_cap.total_supply() }
public fun junior_supply(pool: &LendingPool): u64 { pool.junior_cap.total_supply() }
public fun has_loan(pool: &LendingPool, human_key: vector<u8>): bool { pool.loans.contains(human_key) }
public fun has_terms(pool: &LendingPool, human_key: vector<u8>): bool { pool.terms.contains(human_key) }

public fun amount_owed(pool: &LendingPool, human_key: vector<u8>): u64 {
    if (!pool.loans.contains(human_key)) return 0;
    let loan = &pool.loans[human_key];
    (loan.principal_mist - loan.repaid_principal_mist) + (loan.fee_mist - loan.repaid_fee_mist)
}
