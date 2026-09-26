/// Fair resale market for settled claims.
///
/// * Asking price is capped at 110% of face value (`EPriceExceedsFairCap`).
/// * A listed claim is held by the market object (transfer-to-object), so the buyer can take it
///   without the seller's cooperation.
/// * Buyers must be World ID-verified humans (attestation "buy-resale", target = the claim) and each
///   human may buy only one resale claim per drop — scalpers can't sweep a drop's resales.
/// * Proceeds go through the lending IncomeRouter: the seller's outstanding loan is repaid first.
module scalpless::market;

use scalpless::claim::{Self, Claim};
use scalpless::lending::LendingPool;
use scalpless::passport::PassportRegistry;
use scalpless::registry::{Self, Attested};
use sui::coin::Coin;
use sui::event;
use sui::sui::SUI;
use sui::table::{Self, Table};
use sui::transfer::Receiving;

const FAIR_CAP_BPS: u64 = 11_000;

const EPriceExceedsFairCap: u64 = 0;
const ENotListed: u64 = 1;
const ENotSeller: u64 = 2;
const EWrongPrice: u64 = 3;
const EAlreadyBoughtThisDrop: u64 = 4;
const ESelfPurchase: u64 = 5;
const ELockedOut: u64 = 6;

public struct Market has key {
    id: UID,
    listings: Table<ID, Listing>,
    /// drop id bytes ++ human key → bought a resale claim from that drop.
    bought: Table<vector<u8>, bool>,
}

public struct Listing has drop, store {
    seller: address,
    seller_human: vector<u8>,
    ask_mist: u64,
    face_price_mist: u64,
    drop_id: ID,
}

public struct Listed has copy, drop { claim_id: ID, drop_id: ID, seller: address, ask_mist: u64, face_price_mist: u64 }
public struct Delisted has copy, drop { claim_id: ID }
public struct Sold has copy, drop { claim_id: ID, drop_id: ID, seller: address, buyer: address, price_mist: u64 }

fun init(ctx: &mut TxContext) {
    transfer::share_object(Market { id: object::new(ctx), listings: table::new(ctx), bought: table::new(ctx) });
}

public fun list(market: &mut Market, mut claim: Claim, ask_mist: u64, ctx: &TxContext) {
    claim.assert_holder(ctx);
    claim.assert_status(claim::status_settled());
    let face = claim.face_price_mist();
    assert!((ask_mist as u128) * 10_000 <= (face as u128) * (FAIR_CAP_BPS as u128), EPriceExceedsFairCap);
    let claim_id = object::id(&claim);
    market.listings.add(claim_id, Listing {
        seller: ctx.sender(),
        seller_human: claim.human_key(),
        ask_mist,
        face_price_mist: face,
        drop_id: claim.drop_id(),
    });
    claim.set_status(claim::status_listed());
    event::emit(Listed { claim_id, drop_id: claim.drop_id(), seller: ctx.sender(), ask_mist, face_price_mist: face });
    claim::escrow(claim, object::id_address(market));
}

public fun delist(market: &mut Market, to_receive: Receiving<Claim>, ctx: &TxContext) {
    let mut claim = claim::receive(&mut market.id, to_receive);
    let claim_id = object::id(&claim);
    assert!(market.listings.contains(claim_id), ENotListed);
    let listing = market.listings.remove(claim_id);
    assert!(listing.seller == ctx.sender(), ENotSeller);
    claim.set_status(claim::status_settled());
    event::emit(Delisted { claim_id });
    claim::deliver(claim);
}

/// Buy a listed claim. The sender may be the human or their delegated agent; the claim always
/// goes to the human's own wallet.
public fun buy(
    market: &mut Market,
    pool: &mut LendingPool,
    preg: &mut PassportRegistry,
    attested: Attested,
    to_receive: Receiving<Claim>,
    payment: Coin<SUI>,
    ctx: &TxContext,
) {
    let mut claim = claim::receive(&mut market.id, to_receive);
    let claim_id = object::id(&claim);
    assert!(market.listings.contains(claim_id), ENotListed);
    let listing = market.listings.remove(claim_id);

    let (buyer_human, _, _) = registry::consume(attested, b"buy-resale", object::id_address(&claim), ctx);
    preg.assert_acts_for(buyer_human, ctx.sender());
    assert!(!preg.is_locked_out(buyer_human), ELockedOut);
    assert!(buyer_human != listing.seller_human, ESelfPurchase);
    assert!(payment.value() == listing.ask_mist, EWrongPrice);

    let mut key = object::id_to_bytes(&listing.drop_id);
    key.append(buyer_human);
    assert!(!market.bought.contains(key), EAlreadyBoughtThisDrop);
    market.bought.add(key, true);

    pool.route_income(preg, listing.seller_human, payment, listing.seller);

    let buyer = preg.owner_of(buyer_human);
    let deadline = claim.claim_deadline_ms();
    claim.reassign(buyer, buyer_human, claim::status_settled(), deadline);
    event::emit(Sold { claim_id, drop_id: listing.drop_id, seller: listing.seller, buyer, price_mist: listing.ask_mist });
    claim::deliver(claim);
}

public fun is_listed(market: &Market, claim_id: ID): bool { market.listings.contains(claim_id) }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
