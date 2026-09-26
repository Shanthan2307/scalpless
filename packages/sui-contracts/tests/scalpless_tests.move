#[test_only, allow(untyped_literal)]
module scalpless::scalpless_tests;

use scalpless::claim::{Self, Claim};
use scalpless::drop::{Self, Drop};
use scalpless::junior_lp::JUNIOR_LP;
use scalpless::lending::{Self, LendingPool, UnderwriterCap};
use scalpless::market::{Self, Market};
use scalpless::passport::{Self, PassportRegistry, PassportBadge};
use scalpless::registry::{Self, Registry, AdminCap};
use scalpless::senior_lp::SENIOR_LP;
use scalpless::settlement::{Self, LayawayPlan};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::random::{Self, Random};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xAD;
const SELLER: address = @0x5E11;
const ALICE: address = @0xA11CE; // Orb (tier 3)
const BOB: address = @0xB0B; // passport (tier 2)
const CAROL: address = @0xCA501; // Orb (tier 3)
const AGENT: address = @0xA6E;
const LENDER: address = @0x1E;
const KEEPER: address = @0x4EE;

const ONE_SUI: u64 = 1_000_000_000;
const MIN: u64 = 60_000;
const T0: u64 = 1_000_000;

fun alice_key(): vector<u8> { x"a1" }
fun bob_key(): vector<u8> { x"b0" }
fun carol_key(): vector<u8> { x"ca" }

// ---- helpers ----------------------------------------------------------------------------------

fun setup(): (Scenario, Clock) {
    let mut sc = ts::begin(ADMIN);
    registry::init_for_testing(sc.ctx());
    passport::init_for_testing(sc.ctx());
    market::init_for_testing(sc.ctx());
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(T0);

    sc.next_tx(ADMIN);
    {
        let cap = sc.take_from_sender<AdminCap>();
        let senior = coin::create_treasury_cap_for_testing<SENIOR_LP>(sc.ctx());
        let junior = coin::create_treasury_cap_for_testing<JUNIOR_LP>(sc.ctx());
        // senior gets 40% of fees; 8-minute term (2-minute installments); 1-minute grace
        let uw = lending::create_pool(&cap, senior, junior, 4_000, 8 * MIN, MIN, sc.ctx());
        transfer::public_transfer(uw, ADMIN);
        sc.return_to_sender(cap);
    };

    sc.next_tx(@0x0);
    random::create_for_testing(sc.ctx());
    sc.next_tx(@0x0);
    {
        let mut r = sc.take_shared<Random>();
        r.update_randomness_state_for_testing(0, x"1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F", sc.ctx());
        ts::return_shared(r);
    };
    (sc, clock)
}

fun finish(sc: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    sc.end();
}

fun register(sc: &mut Scenario, who: address, human: vector<u8>, tier: u8) {
    sc.next_tx(who);
    let mut preg = sc.take_shared<PassportRegistry>();
    let a = registry::attested_for_testing(human, tier, b"mint-credit-passport", object::id_address(&preg), sc.ctx());
    preg.register(a, sc.ctx());
    ts::return_shared(preg);
}

fun create_drop(sc: &mut Scenario, clock: &Clock, units: u64, min_tier: u8) {
    sc.next_tx(SELLER);
    drop::create_drop(b"PS5 30th Anniversary".to_string(), ONE_SUI, units, min_tier, T0 + 5 * MIN, 10 * MIN, 2 * MIN, clock, sc.ctx());
}

fun enter(sc: &mut Scenario, clock: &Clock, who: address, human: vector<u8>) {
    sc.next_tx(who);
    let mut d = sc.take_shared<Drop>();
    let mut preg = sc.take_shared<PassportRegistry>();
    let a = registry::attested_for_testing(human, 0, b"enter-drop", object::id_address(&d), sc.ctx());
    let deposit = coin::mint_for_testing<SUI>(ONE_SUI / 10, sc.ctx());
    d.enter(&mut preg, a, deposit, clock, sc.ctx());
    ts::return_shared(d);
    ts::return_shared(preg);
}

fun draw(sc: &mut Scenario, clock: &mut Clock) {
    clock.set_for_testing(T0 + 6 * MIN);
    sc.next_tx(KEEPER);
    let mut d = sc.take_shared<Drop>();
    let mut preg = sc.take_shared<PassportRegistry>();
    let r = sc.take_shared<Random>();
    d.execute_draw_for_testing(&mut preg, &r, clock, sc.ctx());
    ts::return_shared(d);
    ts::return_shared(preg);
    ts::return_shared(r);
}

fun verify_liveness(sc: &mut Scenario, clock: &Clock, who: address, human: vector<u8>) {
    sc.next_tx(who);
    let mut c = sc.take_from_sender<Claim>();
    let a = registry::attested_for_testing(human, 3, b"claim-win", object::id_address(&c), sc.ctx());
    c.verify_liveness(a, clock, sc.ctx());
    sc.return_to_sender(c);
}

fun pay_in_full(sc: &mut Scenario, clock: &Clock, who: address) {
    sc.next_tx(who);
    let mut d = sc.take_shared<Drop>();
    let mut c = sc.take_from_sender<Claim>();
    let pay = coin::mint_for_testing<SUI>(ONE_SUI - ONE_SUI / 10, sc.ctx());
    settlement::pay_in_full(&mut d, &mut c, pay, clock, sc.ctx());
    sc.return_to_sender(c);
    ts::return_shared(d);
}

fun fund_pool(sc: &mut Scenario, senior_mist: u64, junior_mist: u64) {
    sc.next_tx(LENDER);
    let mut pool = sc.take_shared<LendingPool>();
    let s = pool.deposit_senior(coin::mint_for_testing<SUI>(senior_mist, sc.ctx()), sc.ctx());
    let j = pool.deposit_junior(coin::mint_for_testing<SUI>(junior_mist, sc.ctx()), sc.ctx());
    transfer::public_transfer(s, LENDER);
    transfer::public_transfer(j, LENDER);
    ts::return_shared(pool);
}

fun set_terms(sc: &mut Scenario, human: vector<u8>, max_principal: u64, fee_bps: u64) {
    sc.next_tx(ADMIN);
    let uw = sc.take_from_sender<UnderwriterCap>();
    let mut pool = sc.take_shared<LendingPool>();
    uw.set_terms(&mut pool, human, max_principal, fee_bps, 1, x"00", T0 + 60 * MIN);
    ts::return_shared(pool);
    sc.return_to_sender(uw);
}

fun borrow(sc: &mut Scenario, clock: &Clock, who: address) {
    sc.next_tx(who);
    let mut pool = sc.take_shared<LendingPool>();
    let mut d = sc.take_shared<Drop>();
    let mut preg = sc.take_shared<PassportRegistry>();
    let mut c = sc.take_from_sender<Claim>();
    pool.borrow_for_claim(&mut d, &mut c, &mut preg, clock, sc.ctx());
    sc.return_to_sender(c);
    ts::return_shared(pool);
    ts::return_shared(d);
    ts::return_shared(preg);
}

/// Sum of all SUI coins an address received so far.
fun sui_balance(sc: &Scenario, who: address): u64 {
    let ids = ts::ids_for_address<Coin<SUI>>(who);
    let mut total = 0;
    let mut i = 0;
    while (i < ids.length()) {
        let c = sc.take_from_address_by_id<Coin<SUI>>(who, ids[i]);
        total = total + c.value();
        ts::return_to_address(who, c);
        i = i + 1;
    };
    total
}

// ---- registry ---------------------------------------------------------------------------------

#[test]
/// A signature produced by the TypeScript backend serializer verifies on-chain (BCS layouts match).
fun golden_signature_verifies() {
    let mut sc = ts::begin(ALICE);
    registry::init_for_testing(sc.ctx());
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(5_000);
    sc.next_tx(ALICE);
    let cap = sc.take_from_address<AdminCap>(ALICE);
    let mut reg = sc.take_shared<Registry>();
    cap.set_verifier(&mut reg, x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c");
    let a = reg.verify(
        &clock,
        x"abababababababababababababababababababababababababababababababab",
        3,
        b"enter-drop",
        @0xd0,
        0,
        10_000,
        x"255b7a8ed70b43dca3d22ac93be4ed842596e48951f0b2b2d658b8484892871d3bfd7d84f7c0355576f95b9d1e3a839884a2222805440e8b976b7726571af905",
        sc.ctx(),
    );
    let (_, tier, _) = registry::consume(a, b"enter-drop", @0xd0, sc.ctx());
    assert!(tier == 3);
    ts::return_shared(reg);
    sc.return_to_sender(cap);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = registry::EBadSignature)]
/// The same attestation sent by a different wallet fails: the subject is part of what was signed.
fun signature_bound_to_sender() {
    let mut sc = ts::begin(ALICE);
    registry::init_for_testing(sc.ctx());
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(5_000);
    sc.next_tx(ALICE);
    let cap = sc.take_from_address<AdminCap>(ALICE);
    let mut reg = sc.take_shared<Registry>();
    cap.set_verifier(&mut reg, x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c");
    sc.return_to_sender(cap);
    ts::return_shared(reg);
    sc.next_tx(BOB);
    let reg = sc.take_shared<Registry>();
    let a = reg.verify(
        &clock,
        x"abababababababababababababababababababababababababababababababab",
        3,
        b"enter-drop",
        @0xd0,
        0,
        10_000,
        x"255b7a8ed70b43dca3d22ac93be4ed842596e48951f0b2b2d658b8484892871d3bfd7d84f7c0355576f95b9d1e3a839884a2222805440e8b976b7726571af905",
        sc.ctx(),
    );
    let (_, _, _) = registry::consume(a, b"enter-drop", @0xd0, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::EWrongTarget)]
/// An attestation for one object can't be spent on another.
fun attestation_wrong_target_fails() {
    let (mut sc, _clock) = setup();
    sc.next_tx(ALICE);
    let mut preg = sc.take_shared<PassportRegistry>();
    let a = registry::attested_for_testing(alice_key(), 3, b"mint-credit-passport", @0xBAD, sc.ctx());
    preg.register(a, sc.ctx());
    abort 0
}

// ---- passport ---------------------------------------------------------------------------------

#[test]
fun passport_register() {
    let (mut sc, clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    sc.next_tx(ALICE);
    assert!(ts::has_most_recent_for_address<PassportBadge>(ALICE));
    let preg = sc.take_shared<PassportRegistry>();
    assert!(preg.owner_of(alice_key()) == ALICE);
    assert!(preg.credit_limit_mist(alice_key()) == ONE_SUI); // Orb starting limit
    assert!(preg.human_of(ALICE) == alice_key());
    ts::return_shared(preg);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = passport::EAlreadyRegistered)]
/// One human, one passport — even from a fresh wallet.
fun passport_one_per_human() {
    let (mut sc, _clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    register(&mut sc, BOB, alice_key(), 3);
    abort 0
}

// ---- drops ------------------------------------------------------------------------------------

#[test, expected_failure(abort_code = drop::EAlreadyEntered)]
fun drop_one_entry_per_human() {
    let (mut sc, clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    enter(&mut sc, &clock, ALICE, alice_key());
    abort 0
}

#[test, expected_failure(abort_code = drop::ETierTooLow)]
/// Tier comes from the passport: a tier-2 human can't enter an Orb-only drop.
fun drop_tier_from_passport() {
    let (mut sc, clock) = setup();
    register(&mut sc, BOB, bob_key(), 2);
    create_drop(&mut sc, &clock, 1, 3);
    enter(&mut sc, &clock, BOB, bob_key());
    abort 0
}

#[test, expected_failure(abort_code = passport::ENotAuthorized)]
/// A wallet can't enter as someone else's human key.
fun drop_cannot_enter_as_other_human() {
    let (mut sc, clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    register(&mut sc, BOB, bob_key(), 2);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, BOB, alice_key());
    abort 0
}

#[test]
/// Real sui::random draw: 1 unit, 3 entrants → 1 claim, 2 refunds, 2 on the waitlist.
fun draw_mints_claim_and_refunds_losers() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    register(&mut sc, BOB, bob_key(), 2);
    register(&mut sc, CAROL, carol_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    enter(&mut sc, &clock, BOB, bob_key());
    enter(&mut sc, &clock, CAROL, carol_key());
    draw(&mut sc, &mut clock);

    sc.next_tx(KEEPER);
    let winners = (if (ts::has_most_recent_for_address<Claim>(ALICE)) 1 else 0)
        + (if (ts::has_most_recent_for_address<Claim>(BOB)) 1 else 0)
        + (if (ts::has_most_recent_for_address<Claim>(CAROL)) 1 else 0);
    assert!(winners == 1);
    let refunds = (if (sui_balance(&sc, ALICE) == ONE_SUI / 10) 1 else 0)
        + (if (sui_balance(&sc, BOB) == ONE_SUI / 10) 1 else 0)
        + (if (sui_balance(&sc, CAROL) == ONE_SUI / 10) 1 else 0);
    assert!(refunds == 2);
    let d = sc.take_shared<Drop>();
    assert!(d.waitlist_length() == 2);
    assert!(d.vault_value() == ONE_SUI / 10); // only the winner's deposit remains
    ts::return_shared(d);
    finish(sc, clock);
}

#[test]
/// An agent delegated by Alice enters for her; the claim still goes to Alice's own wallet.
fun agent_enters_for_human() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    sc.next_tx(ALICE);
    {
        let mut preg = sc.take_shared<PassportRegistry>();
        let a = registry::attested_for_testing(alice_key(), 3, b"delegate-agent", AGENT, sc.ctx());
        preg.delegate_agent(a, AGENT, sc.ctx());
        ts::return_shared(preg);
    };
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, AGENT, alice_key());
    draw(&mut sc, &mut clock);
    sc.next_tx(KEEPER);
    assert!(ts::has_most_recent_for_address<Claim>(ALICE));
    assert!(!ts::has_most_recent_for_address<Claim>(AGENT));
    finish(sc, clock);
}

// ---- settlement -------------------------------------------------------------------------------

#[test]
fun pay_in_full_pays_seller_face_price() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, alice_key());
    pay_in_full(&mut sc, &clock, ALICE);
    sc.next_tx(ALICE);
    assert!(sui_balance(&sc, SELLER) == ONE_SUI);
    let c = sc.take_from_sender<Claim>();
    assert!(c.status() == claim::status_settled());
    sc.return_to_sender(c);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = claim::EWrongHuman)]
/// A win can only be claimed with the winner's own World ID.
fun liveness_requires_winning_human() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, bob_key());
    abort 0
}

#[test, expected_failure(abort_code = claim::EWrongStatus)]
/// No settlement before the winner proves liveness.
fun pay_requires_liveness() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    pay_in_full(&mut sc, &clock, ALICE);
    abort 0
}

#[test]
/// Layaway: plan holds the claim; after 4 installments the claim returns settled and credit grows.
fun layaway_completes_and_raises_limit() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, alice_key());

    sc.next_tx(ALICE);
    {
        let mut d = sc.take_shared<Drop>();
        let c = sc.take_from_sender<Claim>();
        let down = coin::mint_for_testing<SUI>(ONE_SUI / 4 - ONE_SUI / 10, sc.ctx());
        settlement::start_layaway(&mut d, c, down, &clock, sc.ctx());
        ts::return_shared(d);
    };
    let mut i = 0;
    while (i < 3) {
        sc.next_tx(ALICE);
        let mut plan = sc.take_shared<LayawayPlan>();
        settlement::pay_installment(&mut plan, coin::mint_for_testing<SUI>(ONE_SUI / 4, sc.ctx()), &clock);
        ts::return_shared(plan);
        i = i + 1;
    };
    sc.next_tx(ALICE);
    {
        let mut plan = sc.take_shared<LayawayPlan>();
        let mut preg = sc.take_shared<PassportRegistry>();
        let ticket = ts::most_recent_receiving_ticket<Claim>(&object::id(&plan));
        settlement::complete_layaway(&mut plan, &mut preg, ticket, sc.ctx());
        assert!(preg.completed_layaways(alice_key()) == 1);
        assert!(preg.credit_limit_mist(alice_key()) == ONE_SUI + ONE_SUI / 4);
        ts::return_shared(plan);
        ts::return_shared(preg);
    };
    sc.next_tx(ALICE);
    assert!(sui_balance(&sc, SELLER) == ONE_SUI);
    let c = sc.take_from_sender<Claim>();
    assert!(c.status() == claim::status_settled());
    sc.return_to_sender(c);
    finish(sc, clock);
}

#[test]
/// Missed installment: anyone can default the plan; the buyer is refunded 95% and the claim goes
/// to the next human on the waitlist.
fun layaway_default_passes_claim_to_waitlist() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    register(&mut sc, CAROL, carol_key(), 3);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    enter(&mut sc, &clock, CAROL, carol_key());
    draw(&mut sc, &mut clock);
    sc.next_tx(KEEPER);
    let alice_won = ts::has_most_recent_for_address<Claim>(ALICE);
    let (winner, winner_key, loser) = if (alice_won) (ALICE, alice_key(), CAROL) else (CAROL, carol_key(), ALICE);
    let loser_refund = sui_balance(&sc, loser);

    verify_liveness(&mut sc, &clock, winner, winner_key);
    sc.next_tx(winner);
    {
        let mut d = sc.take_shared<Drop>();
        let c = sc.take_from_sender<Claim>();
        settlement::start_layaway(&mut d, c, coin::mint_for_testing<SUI>(ONE_SUI / 4 - ONE_SUI / 10, sc.ctx()), &clock, sc.ctx());
        ts::return_shared(d);
    };
    clock.increment_for_testing(3 * MIN); // past the 2-minute installment
    sc.next_tx(KEEPER);
    {
        let mut plan = sc.take_shared<LayawayPlan>();
        let mut d = sc.take_shared<Drop>();
        let mut pool = sc.take_shared<LendingPool>();
        let mut preg = sc.take_shared<PassportRegistry>();
        let ticket = ts::most_recent_receiving_ticket<Claim>(&object::id(&plan));
        settlement::default_layaway(&mut plan, &mut d, &mut pool, &mut preg, ticket, &clock, sc.ctx());
        ts::return_shared(plan);
        ts::return_shared(d);
        ts::return_shared(pool);
        ts::return_shared(preg);
    };
    sc.next_tx(loser);
    let c = sc.take_from_sender<Claim>();
    assert!(c.status() == claim::status_won());
    sc.return_to_sender(c);
    let refund = ONE_SUI / 4 - (ONE_SUI / 4) * 5 / 100;
    assert!(sui_balance(&sc, winner) == refund);
    assert!(sui_balance(&sc, SELLER) == ONE_SUI / 4 - refund);
    assert!(sui_balance(&sc, loser) == loser_refund); // unchanged: the waitlist is free
    finish(sc, clock);
}

// ---- lending ----------------------------------------------------------------------------------

#[test]
/// Borrow on yourself: the pool pays the seller, the loan is repaid, lenders earn the fee.
fun borrow_repay_and_lp_yield() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    fund_pool(&mut sc, 3 * ONE_SUI, 2 * ONE_SUI);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, alice_key());
    set_terms(&mut sc, alice_key(), ONE_SUI, 1_000); // 10% fee
    borrow(&mut sc, &clock, ALICE);

    sc.next_tx(ALICE);
    assert!(sui_balance(&sc, SELLER) == ONE_SUI);
    let principal = ONE_SUI - ONE_SUI / 10;
    let fee = principal / 10;
    {
        let mut pool = sc.take_shared<LendingPool>();
        let mut preg = sc.take_shared<PassportRegistry>();
        assert!(pool.amount_owed(alice_key()) == principal + fee);
        assert!(pool.cash() == 5 * ONE_SUI - principal);
        let change = pool.repay(&mut preg, alice_key(), coin::mint_for_testing<SUI>(principal + fee, sc.ctx()));
        change.destroy_zero();
        assert!(!pool.has_loan(alice_key()));
        assert!(pool.senior_assets() == 3 * ONE_SUI + fee * 4 / 10);
        assert!(pool.junior_assets() == 2 * ONE_SUI + fee * 6 / 10);
        assert!(pool.senior_assets() + pool.junior_assets() == pool.cash() + pool.outstanding_principal());
        assert!(preg.on_time_repayments(alice_key()) == 1);
        assert!(preg.credit_limit_mist(alice_key()) == ONE_SUI + ONE_SUI / 2);
        ts::return_shared(pool);
        ts::return_shared(preg);
    };

    sc.next_tx(LENDER);
    {
        let mut pool = sc.take_shared<LendingPool>();
        let j = sc.take_from_sender<Coin<JUNIOR_LP>>();
        let out = pool.withdraw_junior(j, sc.ctx());
        assert!(out.value() == 2 * ONE_SUI + fee * 6 / 10);
        transfer::public_transfer(out, LENDER);
        ts::return_shared(pool);
    };
    finish(sc, clock);
}

#[test, expected_failure(abort_code = lending::ENoTerms)]
/// No underwriting decision, no loan.
fun borrow_requires_terms() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    fund_pool(&mut sc, 3 * ONE_SUI, 2 * ONE_SUI);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, alice_key());
    borrow(&mut sc, &clock, ALICE);
    abort 0
}

#[test, expected_failure(abort_code = drop::ELockedOut)]
/// Walk away from a loan: a keeper defaults it after term + grace, the junior tranche absorbs the
/// loss, and the human is locked out — they can't even enter the next drop.
fun default_absorbs_junior_and_locks_out() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    fund_pool(&mut sc, 3 * ONE_SUI, 2 * ONE_SUI);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, alice_key());
    set_terms(&mut sc, alice_key(), ONE_SUI, 1_000);
    borrow(&mut sc, &clock, ALICE);

    clock.increment_for_testing(3 * MIN + 1); // first installment missed + grace
    sc.next_tx(KEEPER);
    {
        let mut pool = sc.take_shared<LendingPool>();
        let mut preg = sc.take_shared<PassportRegistry>();
        pool.mark_late(&mut preg, alice_key(), &clock);
        assert!(preg.standing(alice_key()) == passport::standing_late());
        ts::return_shared(pool);
        ts::return_shared(preg);
    };
    clock.increment_for_testing(6 * MIN); // past term (8m) + grace (1m)
    sc.next_tx(KEEPER);
    {
        let mut pool = sc.take_shared<LendingPool>();
        let mut preg = sc.take_shared<PassportRegistry>();
        pool.mark_default(&mut preg, alice_key(), &clock);
        let principal = ONE_SUI - ONE_SUI / 10;
        assert!(pool.junior_assets() == 2 * ONE_SUI - principal);
        assert!(pool.senior_assets() == 3 * ONE_SUI);
        assert!(pool.senior_assets() + pool.junior_assets() == pool.cash() + pool.outstanding_principal());
        assert!(preg.is_locked_out(alice_key()));
        assert!(preg.credit_limit_mist(alice_key()) == 0);
        ts::return_shared(pool);
        ts::return_shared(preg);
    };
    // A new drop: the locked-out human is turned away.
    sc.next_tx(SELLER);
    drop::create_drop(b"Next drop".to_string(), ONE_SUI, 1, 0, clock.timestamp_ms() + 5 * MIN, 10 * MIN, 2 * MIN, &clock, sc.ctx());
    enter(&mut sc, &clock, ALICE, alice_key());
    abort 0
}

#[test, expected_failure(abort_code = lending::ETermNotElapsed)]
/// Nobody can default a loan early.
fun cannot_default_early() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    fund_pool(&mut sc, 3 * ONE_SUI, 2 * ONE_SUI);
    create_drop(&mut sc, &clock, 1, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    draw(&mut sc, &mut clock);
    verify_liveness(&mut sc, &clock, ALICE, alice_key());
    set_terms(&mut sc, alice_key(), ONE_SUI, 1_000);
    borrow(&mut sc, &clock, ALICE);
    sc.next_tx(KEEPER);
    let mut pool = sc.take_shared<LendingPool>();
    let mut preg = sc.take_shared<PassportRegistry>();
    pool.mark_default(&mut preg, alice_key(), &clock);
    abort 0
}

// ---- market -----------------------------------------------------------------------------------

fun settle_claim_for(sc: &mut Scenario, clock: &mut Clock, who: address, human: vector<u8>) {
    register(sc, who, human, 3);
    create_drop(sc, clock, 1, 0);
    enter(sc, clock, who, human);
    draw(sc, clock);
    verify_liveness(sc, clock, who, human);
}

fun list(sc: &mut Scenario, who: address, ask: u64) {
    sc.next_tx(who);
    let mut m = sc.take_shared<Market>();
    let c = sc.take_from_sender<Claim>();
    m.list(c, ask, sc.ctx());
    ts::return_shared(m);
}

fun buy(sc: &mut Scenario, who: address, human: vector<u8>, price: u64) {
    sc.next_tx(who);
    let mut m = sc.take_shared<Market>();
    let mut pool = sc.take_shared<LendingPool>();
    let mut preg = sc.take_shared<PassportRegistry>();
    let ticket = ts::most_recent_receiving_ticket<Claim>(&object::id(&m));
    let claim_addr = ticket.receiving_object_id().to_address();
    let a = registry::attested_for_testing(human, 2, b"buy-resale", claim_addr, sc.ctx());
    m.buy(&mut pool, &mut preg, a, ticket, coin::mint_for_testing<SUI>(price, sc.ctx()), sc.ctx());
    ts::return_shared(m);
    ts::return_shared(pool);
    ts::return_shared(preg);
}

#[test, expected_failure(abort_code = market::EPriceExceedsFairCap)]
fun market_rejects_scalper_price() {
    let (mut sc, mut clock) = setup();
    settle_claim_for(&mut sc, &mut clock, ALICE, alice_key());
    pay_in_full(&mut sc, &clock, ALICE);
    list(&mut sc, ALICE, ONE_SUI * 110 / 100 + 1);
    abort 0
}

#[test]
/// Resale at the cap: proceeds repay the seller's loan first (IncomeRouter), the rest goes to the
/// seller, and the claim goes to the buyer's wallet.
fun market_resale_repays_seller_loan() {
    let (mut sc, mut clock) = setup();
    fund_pool(&mut sc, 3 * ONE_SUI, 2 * ONE_SUI);
    settle_claim_for(&mut sc, &mut clock, ALICE, alice_key());
    set_terms(&mut sc, alice_key(), ONE_SUI, 1_000);
    borrow(&mut sc, &clock, ALICE);
    register(&mut sc, BOB, bob_key(), 2);

    let ask = ONE_SUI * 110 / 100;
    list(&mut sc, ALICE, ask);
    buy(&mut sc, BOB, bob_key(), ask);

    sc.next_tx(BOB);
    let principal = ONE_SUI - ONE_SUI / 10;
    let owed = principal + principal / 10;
    {
        let pool = sc.take_shared<LendingPool>();
        assert!(!pool.has_loan(alice_key()));
        ts::return_shared(pool);
    };
    assert!(sui_balance(&sc, ALICE) == ask - owed);
    let c = sc.take_from_sender<Claim>();
    assert!(c.holder() == BOB && c.human_key() == bob_key());
    sc.return_to_sender(c);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = market::EAlreadyBoughtThisDrop)]
/// One resale claim per human per drop — no sweeping.
fun market_one_resale_per_drop() {
    let (mut sc, mut clock) = setup();
    register(&mut sc, ALICE, alice_key(), 3);
    register(&mut sc, CAROL, carol_key(), 3);
    register(&mut sc, BOB, bob_key(), 2);
    create_drop(&mut sc, &clock, 2, 0);
    enter(&mut sc, &clock, ALICE, alice_key());
    enter(&mut sc, &clock, CAROL, carol_key());
    draw(&mut sc, &mut clock); // 2 units, 2 entrants: both win
    verify_liveness(&mut sc, &clock, ALICE, alice_key());
    verify_liveness(&mut sc, &clock, CAROL, carol_key());
    pay_in_full(&mut sc, &clock, ALICE);
    pay_in_full(&mut sc, &clock, CAROL);
    list(&mut sc, ALICE, ONE_SUI);
    buy(&mut sc, BOB, bob_key(), ONE_SUI);
    list(&mut sc, CAROL, ONE_SUI);
    buy(&mut sc, BOB, bob_key(), ONE_SUI);
    abort 0
}
