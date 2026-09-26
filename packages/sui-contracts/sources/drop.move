/// Fair drops: one entry per human, a refundable 10% deposit, and a three-round weighted draw
/// using Sui's on-chain randomness.
///
/// Tickets scale with World ID assurance (selfie 1, passport 3, Orb 6; +1 after a previous loss).
/// Round I is open to every tier, round II to tier 2+, round III to Orb humans (falling back to
/// everyone left if no Orb entrant remains). Losers are refunded in the draw transaction and
/// placed on a randomly ordered waitlist that inherits claims from defaulted layaways.
module scalpless::drop;

use scalpless::claim;
use scalpless::passport::PassportRegistry;
use scalpless::registry::{Self, Attested};
use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::random::{Self, Random};
use sui::sui::SUI;
use sui::table::{Self, Table};

const OPEN: u8 = 0;
const DRAWN: u8 = 1;

const MAX_ENTRANTS: u64 = 200;
const MIN_WINDOW_MS: u64 = 60_000;

const ENotOpen: u64 = 0;
const EEntryClosed: u64 = 1;
const EAlreadyEntered: u64 = 2;
const ETierTooLow: u64 = 3;
const EWrongDeposit: u64 = 4;
const EDropFull: u64 = 5;
const ETooEarly: u64 = 6;
const ELockedOut: u64 = 7;
const EBadParams: u64 = 8;

public struct Drop has key {
    id: UID,
    title: String,
    seller: address,
    face_price_mist: u64,
    deposit_mist: u64,
    total_units: u64,
    min_tier: u8,
    entry_deadline_ms: u64,
    /// How long a winner has to verify liveness and settle.
    claim_window_ms: u64,
    /// Layaway installment interval for claims from this drop.
    installment_interval_ms: u64,
    status: u8,
    vault: Balance<SUI>,
    entered: Table<vector<u8>, bool>,
    entries: vector<Entry>,
    /// Losers in random order; the next one inherits a claim whose layaway defaulted.
    waitlist: vector<Entry>,
}

public struct Entry has copy, drop, store {
    human_key: vector<u8>,
    /// Human's own wallet — receives the claim if they win.
    beneficiary: address,
    /// Wallet that paid the deposit (the human or their agent) — receives the refund.
    payer: address,
    tier: u8,
    tickets: u64,
    round_won: u8,
}

public struct DropCreated has copy, drop { drop_id: ID, title: String, seller: address, face_price_mist: u64, total_units: u64, entry_deadline_ms: u64 }
public struct Entered has copy, drop { drop_id: ID, human_key: vector<u8>, payer: address, tier: u8, tickets: u64 }
public struct Won has copy, drop { drop_id: ID, claim_id: ID, winner: address, human_key: vector<u8>, round: u8 }
public struct Refunded has copy, drop { drop_id: ID, payer: address, amount_mist: u64 }

public fun create_drop(
    title: String,
    face_price_mist: u64,
    total_units: u64,
    min_tier: u8,
    entry_deadline_ms: u64,
    claim_window_ms: u64,
    installment_interval_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(total_units > 0 && face_price_mist >= 10 && min_tier <= 3, EBadParams);
    assert!(entry_deadline_ms > clock.timestamp_ms(), EBadParams);
    assert!(claim_window_ms >= MIN_WINDOW_MS && installment_interval_ms >= MIN_WINDOW_MS, EBadParams);
    let drop = Drop {
        id: object::new(ctx),
        title,
        seller: ctx.sender(),
        face_price_mist,
        deposit_mist: face_price_mist / 10,
        total_units,
        min_tier,
        entry_deadline_ms,
        claim_window_ms,
        installment_interval_ms,
        status: OPEN,
        vault: balance::zero(),
        entered: table::new(ctx),
        entries: vector[],
        waitlist: vector[],
    };
    event::emit(DropCreated { drop_id: object::id(&drop), title, seller: drop.seller, face_price_mist, total_units, entry_deadline_ms });
    transfer::share_object(drop);
}

/// Enter with a World ID attestation (action "enter-drop", target = this drop). The sender may be
/// the human or an agent they delegated; either way the human gets one entry.
public fun enter(
    drop: &mut Drop,
    preg: &mut PassportRegistry,
    attested: Attested,
    deposit: Coin<SUI>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let (human_key, _, _) = registry::consume(attested, b"enter-drop", object::id_address(drop), ctx);
    preg.assert_acts_for(human_key, ctx.sender());
    assert!(!preg.is_locked_out(human_key), ELockedOut);
    assert!(drop.status == OPEN, ENotOpen);
    assert!(clock.timestamp_ms() < drop.entry_deadline_ms, EEntryClosed);
    assert!(!drop.entered.contains(human_key), EAlreadyEntered);
    assert!(drop.entries.length() < MAX_ENTRANTS, EDropFull);
    // Tier comes from the passport (set by the verified World ID proof), not the caller.
    let tier = preg.credential_tier(human_key);
    assert!(tier >= drop.min_tier, ETierTooLow);
    assert!(deposit.value() == drop.deposit_mist, EWrongDeposit);

    let mut tickets = if (tier >= 3) 6 else if (tier == 2) 3 else 1;
    if (preg.drop_losses(human_key) > 0) tickets = tickets + 1;

    drop.vault.join(deposit.into_balance());
    drop.entered.add(human_key, true);
    let payer = ctx.sender();
    drop.entries.push_back(Entry { human_key, beneficiary: preg.owner_of(human_key), payer, tier, tickets, round_won: 0 });
    event::emit(Entered { drop_id: object::id(drop), human_key, payer, tier, tickets });
}

/// Anyone can run the draw once entries close.
entry fun execute_draw(drop: &mut Drop, preg: &mut PassportRegistry, r: &Random, clock: &Clock, ctx: &mut TxContext) {
    assert!(drop.status == OPEN, ENotOpen);
    assert!(clock.timestamp_ms() >= drop.entry_deadline_ms, ETooEarly);
    drop.status = DRAWN;

    let mut generator = random::new_generator(r, ctx);
    let units = drop.total_units;
    let r1 = (units + 2) / 3;
    let r2 = (units + 1) / 3;
    let r3 = units - r1 - r2;
    draw_round(drop, &mut generator, r1, 1, 1);
    draw_round(drop, &mut generator, r2, 2, 2);
    draw_round(drop, &mut generator, r3, 3, 3);

    let drop_id = object::id(drop);
    let claim_deadline = clock.timestamp_ms() + drop.claim_window_ms;
    let mut losers = vector[];
    let mut i = 0;
    while (i < drop.entries.length()) {
        let e = drop.entries[i];
        if (e.round_won > 0) {
            let claim_id = claim::mint(
                drop_id, drop.title, e.beneficiary, e.human_key, drop.seller,
                drop.face_price_mist, drop.deposit_mist, claim_deadline, ctx,
            );
            event::emit(Won { drop_id, claim_id, winner: e.beneficiary, human_key: e.human_key, round: e.round_won });
        } else {
            transfer::public_transfer(coin::take(&mut drop.vault, drop.deposit_mist, ctx), e.payer);
            preg.record_drop_loss(e.human_key);
            event::emit(Refunded { drop_id, payer: e.payer, amount_mist: drop.deposit_mist });
            losers.push_back(e);
        };
        i = i + 1;
    };
    generator.shuffle(&mut losers);
    drop.waitlist = losers;
}

/// Weighted pick of `count` winners among un-picked entries with tier ≥ `min_tier`. Round III
/// falls back to every remaining entrant if no one qualifies.
fun draw_round(drop: &mut Drop, generator: &mut random::RandomGenerator, count: u64, min_tier: u8, round: u8) {
    let mut picked = 0;
    while (picked < count) {
        let mut floor = min_tier;
        let mut total = eligible_tickets(&drop.entries, floor);
        if (total == 0 && round == 3) {
            floor = 0;
            total = eligible_tickets(&drop.entries, floor);
        };
        if (total == 0) return;
        let winning = generator.generate_u64_in_range(1, total);
        let mut running = 0;
        let mut i = 0;
        while (i < drop.entries.length()) {
            let e = &mut drop.entries[i];
            if (e.round_won == 0 && e.tier >= floor) {
                running = running + e.tickets;
                if (running >= winning) {
                    e.round_won = round;
                    break
                };
            };
            i = i + 1;
        };
        picked = picked + 1;
    };
}

fun eligible_tickets(entries: &vector<Entry>, min_tier: u8): u64 {
    let mut total = 0;
    let mut i = 0;
    while (i < entries.length()) {
        let e = &entries[i];
        if (e.round_won == 0 && e.tier >= min_tier) total = total + e.tickets;
        i = i + 1;
    };
    total
}

// ---- used by settlement / lending ------------------------------------------------------------

/// Release a winner's entry deposit (applied toward the face price).
public(package) fun take_deposit(drop: &mut Drop, amount_mist: u64): Balance<SUI> { drop.vault.split(amount_mist) }

/// Next human on the waitlist, if any: (human_key, beneficiary wallet).
public(package) fun pop_waitlist(drop: &mut Drop): Option<Entry> {
    if (drop.waitlist.is_empty()) option::none() else option::some(drop.waitlist.remove(0))
}

public fun entry_human_key(e: &Entry): vector<u8> { e.human_key }
public fun entry_beneficiary(e: &Entry): address { e.beneficiary }

public fun seller(drop: &Drop): address { drop.seller }
public fun face_price_mist(drop: &Drop): u64 { drop.face_price_mist }
public fun deposit_mist(drop: &Drop): u64 { drop.deposit_mist }
public fun claim_window_ms(drop: &Drop): u64 { drop.claim_window_ms }
public fun installment_interval_ms(drop: &Drop): u64 { drop.installment_interval_ms }
public fun status(drop: &Drop): u8 { drop.status }
public fun entrant_count(drop: &Drop): u64 { drop.entries.length() }
public fun waitlist_length(drop: &Drop): u64 { drop.waitlist.length() }
public fun has_entered(drop: &Drop, human_key: vector<u8>): bool { drop.entered.contains(human_key) }
public fun vault_value(drop: &Drop): u64 { drop.vault.value() }

#[test_only]
public fun execute_draw_for_testing(drop: &mut Drop, preg: &mut PassportRegistry, r: &Random, clock: &Clock, ctx: &mut TxContext) {
    execute_draw(drop, preg, r, clock, ctx)
}
