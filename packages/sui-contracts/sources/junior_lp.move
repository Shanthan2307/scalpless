/// Scalpless Junior LP coin — minted and burned only by the lending pool, which holds the TreasuryCap.
module scalpless::junior_lp;

use sui::coin_registry;

public struct JUNIOR_LP has drop {}

fun init(otw: JUNIOR_LP, ctx: &mut TxContext) {
    let (initializer, treasury_cap) = coin_registry::new_currency_with_otw(
        otw,
        9,
        b"jSCALP".to_string(),
        b"Scalpless Junior LP".to_string(),
        b"Junior tranche share of the Scalpless lending pool: higher interest share, absorbs defaults first.".to_string(),
        b"".to_string(),
        ctx,
    );
    let metadata_cap = initializer.finalize(ctx);
    // Both go to the publisher; the TreasuryCap is moved into the pool by lending::create_pool.
    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_transfer(metadata_cap, ctx.sender());
}

