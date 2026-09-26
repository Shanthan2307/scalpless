/// Human-keyed Credit Passport (ported from EthGlobal26 PassportRegistry.sol).
///
/// Passports live inside one shared registry, keyed by the World ID human key (nullifier), not in
/// the user's wallet. That lets the protocol update a borrower's standing without their
/// cooperation (keepers can mark defaults), and a human's record follows them across wallets.
/// The wallet gets a soulbound `PassportBadge` for display.
module scalpless::passport;

use scalpless::registry::{Self, Attested};
use sui::event;
use sui::table::{Self, Table};

// Standing
const GOOD: u8 = 0;
const LATE: u8 = 1;
const LOCKED_OUT: u8 = 2;

// Credit ladder (MIST). Orb humans start with a small unsecured limit; every on-time repayment
// or completed layaway raises it.
const INITIAL_LIMIT_ORB: u64 = 1_000_000_000;
const INITIAL_LIMIT_DOCUMENT: u64 = 500_000_000;
const REPAYMENT_LIMIT_STEP: u64 = 500_000_000;
const LAYAWAY_LIMIT_STEP: u64 = 250_000_000;
const REPAYMENT_SCORE_BUMP: u64 = 20;
const LAYAWAY_SCORE_BUMP: u64 = 10;
const LATE_SCORE_PENALTY: u64 = 10;
const MAX_AGENTS: u64 = 3;

const EAlreadyRegistered: u64 = 0;
const EWalletTaken: u64 = 1;
const ENoPassport: u64 = 2;
const ENotAuthorized: u64 = 3;
const ENotOwner: u64 = 4;
const ETooManyAgents: u64 = 5;
const EActiveLoan: u64 = 6;

public struct PassportRegistry has key {
    id: UID,
    passports: Table<vector<u8>, Passport>,
    /// Owner wallets and delegated agent addresses → human key.
    by_address: Table<address, vector<u8>>,
}

public struct Passport has store {
    human_key: vector<u8>,
    owner: address,
    credential_tier: u8,
    standing: u8,
    score: u64,
    credit_limit_mist: u64,
    on_time_repayments: u64,
    late_marks: u64,
    defaults: u64,
    completed_layaways: u64,
    drop_losses: u64,
    active_loan: bool,
    agents: vector<address>,
}

/// Soulbound (key only): can't be transferred or sold.
public struct PassportBadge has key {
    id: UID,
    human_key: vector<u8>,
    credential_tier: u8,
}

public struct PassportMinted has copy, drop { human_key: vector<u8>, owner: address, credential_tier: u8, credit_limit_mist: u64 }
public struct AgentDelegated has copy, drop { human_key: vector<u8>, agent: address }
public struct AgentRevoked has copy, drop { human_key: vector<u8>, agent: address }
public struct StandingChanged has copy, drop { human_key: vector<u8>, standing: u8, score: u64, credit_limit_mist: u64 }

fun init(ctx: &mut TxContext) {
    transfer::share_object(PassportRegistry {
        id: object::new(ctx),
        passports: table::new(ctx),
        by_address: table::new(ctx),
    });
}

/// Mint a passport for a World ID-verified human (attestation action "mint-credit-passport").
public fun register(preg: &mut PassportRegistry, attested: Attested, ctx: &mut TxContext) {
    let (human_key, credential_tier, _) = registry::consume(attested, b"mint-credit-passport", object::id_address(preg), ctx);
    let owner = ctx.sender();
    assert!(!preg.passports.contains(human_key), EAlreadyRegistered);
    assert!(!preg.by_address.contains(owner), EWalletTaken);

    let credit_limit_mist = if (credential_tier >= 3) INITIAL_LIMIT_ORB
    else if (credential_tier == 2) INITIAL_LIMIT_DOCUMENT
    else 0;

    preg.passports.add(human_key, Passport {
        human_key,
        owner,
        credential_tier,
        standing: GOOD,
        score: 0,
        credit_limit_mist,
        on_time_repayments: 0,
        late_marks: 0,
        defaults: 0,
        completed_layaways: 0,
        drop_losses: 0,
        active_loan: false,
        agents: vector[],
    });
    preg.by_address.add(owner, human_key);
    transfer::transfer(PassportBadge { id: object::new(ctx), human_key, credential_tier }, owner);
    event::emit(PassportMinted { human_key, owner, credential_tier, credit_limit_mist });
}

/// Let an AgentBook-registered agent act for this human (attestation action "delegate-agent",
/// target = the agent's Sui address). Agents can enter drops and buy resales; claims and loans
/// still go to — and need — the human.
public fun delegate_agent(preg: &mut PassportRegistry, attested: Attested, agent: address, ctx: &TxContext) {
    let (human_key, _, _) = registry::consume(attested, b"delegate-agent", agent, ctx);
    assert!(preg.passports.contains(human_key), ENoPassport);
    assert!(!preg.by_address.contains(agent), EWalletTaken);
    let passport = &mut preg.passports[human_key];
    assert!(passport.owner == ctx.sender(), ENotOwner);
    assert!(passport.agents.length() < MAX_AGENTS, ETooManyAgents);
    passport.agents.push_back(agent);
    preg.by_address.add(agent, human_key);
    event::emit(AgentDelegated { human_key, agent });
}

public fun revoke_agent(preg: &mut PassportRegistry, agent: address, ctx: &TxContext) {
    let human_key = preg.human_of(ctx.sender());
    let passport = &mut preg.passports[human_key];
    assert!(passport.owner == ctx.sender(), ENotOwner);
    let (found, i) = passport.agents.index_of(&agent);
    assert!(found, ENotAuthorized);
    passport.agents.remove(i);
    preg.by_address.remove(agent);
    event::emit(AgentRevoked { human_key, agent });
}

// ---- queries ----------------------------------------------------------------------------------

public fun human_of(preg: &PassportRegistry, addr: address): vector<u8> {
    assert!(preg.by_address.contains(addr), ENoPassport);
    preg.by_address[addr]
}

public fun has_passport(preg: &PassportRegistry, human_key: vector<u8>): bool { preg.passports.contains(human_key) }

/// Abort unless `addr` is the human's wallet or one of their delegated agents.
public fun assert_acts_for(preg: &PassportRegistry, human_key: vector<u8>, addr: address) {
    assert!(preg.by_address.contains(addr) && preg.by_address[addr] == human_key, ENotAuthorized);
}

fun borrow(preg: &PassportRegistry, human_key: vector<u8>): &Passport {
    assert!(preg.passports.contains(human_key), ENoPassport);
    &preg.passports[human_key]
}

fun borrow_mut(preg: &mut PassportRegistry, human_key: vector<u8>): &mut Passport {
    assert!(preg.passports.contains(human_key), ENoPassport);
    &mut preg.passports[human_key]
}

public fun owner_of(preg: &PassportRegistry, human_key: vector<u8>): address { preg.borrow(human_key).owner }
public fun credential_tier(preg: &PassportRegistry, human_key: vector<u8>): u8 { preg.borrow(human_key).credential_tier }
public fun standing(preg: &PassportRegistry, human_key: vector<u8>): u8 { preg.borrow(human_key).standing }
public fun is_locked_out(preg: &PassportRegistry, human_key: vector<u8>): bool { preg.borrow(human_key).standing == LOCKED_OUT }
public fun credit_limit_mist(preg: &PassportRegistry, human_key: vector<u8>): u64 { preg.borrow(human_key).credit_limit_mist }
public fun has_active_loan(preg: &PassportRegistry, human_key: vector<u8>): bool { preg.borrow(human_key).active_loan }
public fun drop_losses(preg: &PassportRegistry, human_key: vector<u8>): u64 { preg.borrow(human_key).drop_losses }
public fun score(preg: &PassportRegistry, human_key: vector<u8>): u64 { preg.borrow(human_key).score }
public fun on_time_repayments(preg: &PassportRegistry, human_key: vector<u8>): u64 { preg.borrow(human_key).on_time_repayments }
public fun defaults(preg: &PassportRegistry, human_key: vector<u8>): u64 { preg.borrow(human_key).defaults }
public fun completed_layaways(preg: &PassportRegistry, human_key: vector<u8>): u64 { preg.borrow(human_key).completed_layaways }
public fun standing_good(): u8 { GOOD }
public fun standing_late(): u8 { LATE }
public fun standing_locked_out(): u8 { LOCKED_OUT }

// ---- reputation transitions (driven by drop, settlement and lending) ---------------------------

fun emit_standing(p: &Passport) {
    event::emit(StandingChanged { human_key: p.human_key, standing: p.standing, score: p.score, credit_limit_mist: p.credit_limit_mist });
}

public(package) fun record_drop_loss(preg: &mut PassportRegistry, human_key: vector<u8>) {
    if (!preg.passports.contains(human_key)) return;
    let p = preg.borrow_mut(human_key);
    p.drop_losses = p.drop_losses + 1;
}

public(package) fun record_layaway_completion(preg: &mut PassportRegistry, human_key: vector<u8>) {
    let p = preg.borrow_mut(human_key);
    p.completed_layaways = p.completed_layaways + 1;
    p.score = p.score + LAYAWAY_SCORE_BUMP;
    if (p.standing != LOCKED_OUT) p.credit_limit_mist = p.credit_limit_mist + LAYAWAY_LIMIT_STEP;
    emit_standing(p);
}

public(package) fun record_loan_opened(preg: &mut PassportRegistry, human_key: vector<u8>) {
    let p = preg.borrow_mut(human_key);
    assert!(!p.active_loan, EActiveLoan);
    p.active_loan = true;
}

/// Loan fully repaid: heal Late → Good, bump score and limit.
public(package) fun record_repayment(preg: &mut PassportRegistry, human_key: vector<u8>) {
    let p = preg.borrow_mut(human_key);
    p.active_loan = false;
    if (p.standing == LOCKED_OUT) return;
    p.standing = GOOD;
    p.on_time_repayments = p.on_time_repayments + 1;
    p.score = p.score + REPAYMENT_SCORE_BUMP;
    p.credit_limit_mist = p.credit_limit_mist + REPAYMENT_LIMIT_STEP;
    emit_standing(p);
}

public(package) fun record_late(preg: &mut PassportRegistry, human_key: vector<u8>) {
    let p = preg.borrow_mut(human_key);
    if (p.standing != GOOD) return;
    p.standing = LATE;
    p.late_marks = p.late_marks + 1;
    p.score = if (p.score > LATE_SCORE_PENALTY) p.score - LATE_SCORE_PENALTY else 0;
    emit_standing(p);
}

/// Walked away from a loan: locked out network-wide — no borrowing, no drops — for every wallet
/// this human ever uses.
public(package) fun record_default(preg: &mut PassportRegistry, human_key: vector<u8>) {
    let p = preg.borrow_mut(human_key);
    p.active_loan = false;
    if (p.standing != LOCKED_OUT) p.defaults = p.defaults + 1;
    p.standing = LOCKED_OUT;
    p.score = 0;
    p.credit_limit_mist = 0;
    emit_standing(p);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
