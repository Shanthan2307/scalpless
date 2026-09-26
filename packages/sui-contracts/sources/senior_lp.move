/// Scalpless Senior LP coin — minted and burned only by the lending pool, which holds the TreasuryCap.
module scalpless::senior_lp;

use sui::coin_registry;

public struct SENIOR_LP has drop {}

fun init(otw: SENIOR_LP, ctx: &mut TxContext) {
    let (initializer, treasury_cap) = coin_registry::new_currency_with_otw(
        otw,
        9,
        b"sSCALP".to_string(),
        b"Scalpless Senior LP".to_string(),
        b"Senior tranche share of the Scalpless lending pool: paid first, protected by the junior tranche.".to_string(),
        b"".to_string(),
        ctx,
    );
    let metadata_cap = initializer.finalize(ctx);
    // Both go to the publisher; the TreasuryCap is moved into the pool by lending::create_pool.
    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_transfer(metadata_cap, ctx.sender());
}

