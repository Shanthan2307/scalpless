/// A drop win: the right to buy one physical item at face price (RWA claim).
///
/// `Claim` has `key` but not `store`, so only this package can move it: it can't be sent to a
/// scalper or listed on an outside marketplace. While it is being resold or paid off in layaway,
/// the protocol holds it by transferring it to the market / plan object's address
/// (transfer-to-object) and receives it back with `transfer::receive`.
module scalpless::claim;

use scalpless::registry::{Self, Attested};
use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::transfer::Receiving;

// Status
const WON: u8 = 0;
const LIVENESS_VERIFIED: u8 = 1;
const IN_LAYAWAY: u8 = 2;
const SETTLED: u8 = 3; // paid in full — ready to ship
const LISTED: u8 = 4;

const ENotHolder: u64 = 0;
const EWrongStatus: u64 = 1;
const EClaimExpired: u64 = 2;
const EWrongHuman: u64 = 3;

public struct Claim has key {
    id: UID,
    drop_id: ID,
    item_name: String,
    /// Wallet that holds the claim (always a human's own wallet, never an agent).
    holder: address,
    /// World ID human key of the current holder.
    human_key: vector<u8>,
    seller: address,
    face_price_mist: u64,
    /// Entry deposit still held by the drop vault for this claim.
    deposit_mist: u64,
    claim_deadline_ms: u64,
    status: u8,
}

public struct LivenessVerified has copy, drop { claim_id: ID, human_key: vector<u8> }

public(package) fun mint(
    drop_id: ID,
    item_name: String,
    holder: address,
    human_key: vector<u8>,
    seller: address,
    face_price_mist: u64,
    deposit_mist: u64,
    claim_deadline_ms: u64,
    ctx: &mut TxContext,
): ID {
    let claim = Claim {
        id: object::new(ctx),
        drop_id,
        item_name,
        holder,
        human_key,
        seller,
        face_price_mist,
        deposit_mist,
        claim_deadline_ms,
        status: WON,
    };
    let id = object::id(&claim);
    transfer::transfer(claim, holder);
    id
}

/// The winner proves, with a fresh World ID session proof, that they are the human who won
/// (attestation action "claim-win", target = this claim). Bots that farmed a win can't pass.
public fun verify_liveness(claim: &mut Claim, attested: Attested, clock: &Clock, ctx: &TxContext) {
    let (human_key, _, _) = registry::consume(attested, b"claim-win", object::id_address(claim), ctx);
    assert!(claim.holder == ctx.sender(), ENotHolder);
    assert!(claim.human_key == human_key, EWrongHuman);
    assert!(claim.status == WON, EWrongStatus);
    assert!(clock.timestamp_ms() <= claim.claim_deadline_ms, EClaimExpired);
    claim.status = LIVENESS_VERIFIED;
    event::emit(LivenessVerified { claim_id: object::id(claim), human_key });
}

// ---- custody ----------------------------------------------------------------------------------

public(package) fun escrow(claim: Claim, custodian: address) { transfer::transfer(claim, custodian) }

public(package) fun receive(parent: &mut UID, to_receive: Receiving<Claim>): Claim {
    transfer::receive(parent, to_receive)
}

public(package) fun deliver(claim: Claim) {
    let holder = claim.holder;
    transfer::transfer(claim, holder)
}

/// The item goes back to the seller (e.g. a defaulted layaway with no one on the waitlist).
public(package) fun destroy(claim: Claim) {
    let Claim { id, .. } = claim;
    id.delete();
}

// ---- state ------------------------------------------------------------------------------------

public(package) fun set_status(claim: &mut Claim, status: u8) { claim.status = status }
public(package) fun clear_deposit(claim: &mut Claim) { claim.deposit_mist = 0 }

public(package) fun reassign(claim: &mut Claim, holder: address, human_key: vector<u8>, status: u8, claim_deadline_ms: u64) {
    claim.holder = holder;
    claim.human_key = human_key;
    claim.status = status;
    claim.claim_deadline_ms = claim_deadline_ms;
}

public(package) fun assert_holder(claim: &Claim, ctx: &TxContext) { assert!(claim.holder == ctx.sender(), ENotHolder) }

public(package) fun assert_status(claim: &Claim, status: u8) { assert!(claim.status == status, EWrongStatus) }

public(package) fun assert_not_expired(claim: &Claim, clock: &Clock) {
    assert!(clock.timestamp_ms() <= claim.claim_deadline_ms, EClaimExpired)
}

public fun drop_id(claim: &Claim): ID { claim.drop_id }
public fun item_name(claim: &Claim): String { claim.item_name }
public fun holder(claim: &Claim): address { claim.holder }
public fun human_key(claim: &Claim): vector<u8> { claim.human_key }
public fun seller(claim: &Claim): address { claim.seller }
public fun face_price_mist(claim: &Claim): u64 { claim.face_price_mist }
public fun deposit_mist(claim: &Claim): u64 { claim.deposit_mist }
public fun claim_deadline_ms(claim: &Claim): u64 { claim.claim_deadline_ms }
public fun status(claim: &Claim): u8 { claim.status }

public fun status_won(): u8 { WON }
public fun status_liveness_verified(): u8 { LIVENESS_VERIFIED }
public fun status_in_layaway(): u8 { IN_LAYAWAY }
public fun status_settled(): u8 { SETTLED }
public fun status_listed(): u8 { LISTED }
