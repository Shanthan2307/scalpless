/// Redemption: turn a paid claim into a physical delivery.
///
/// The holder burns their settled claim; the `Redeemed` event is the signal the Scalpless backend
/// turns into a paid Shopify order for the merchant to fulfil (and records on the MultiBaas RWA
/// ledger). Once redeemed, the claim no longer exists, so the same item can't be claimed twice.
/// (Added in a package upgrade.)
module scalpless::redeem;

use scalpless::claim::{Self, Claim};
use std::string::String;
use sui::event;

public struct Redeemed has copy, drop {
    claim_id: ID,
    drop_id: ID,
    holder: address,
    human_key: vector<u8>,
    item_name: String,
    face_price_mist: u64,
}

public fun redeem(claim: Claim, ctx: &TxContext) {
    claim.assert_holder(ctx);
    claim.assert_status(claim::status_settled());
    event::emit(Redeemed {
        claim_id: object::id(&claim),
        drop_id: claim.drop_id(),
        holder: claim.holder(),
        human_key: claim.human_key(),
        item_name: claim.item_name(),
        face_price_mist: claim.face_price_mist(),
    });
    claim::destroy(claim);
}
