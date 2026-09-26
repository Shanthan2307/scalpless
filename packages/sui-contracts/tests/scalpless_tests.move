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
