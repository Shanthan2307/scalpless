/// World ID → Sui bridge.
///
/// Sui has no World ID verifier, so the Scalpless backend verifies each World ID proof and signs
/// an Ed25519 attestation. `verify` checks that signature and returns an `Attested` hot potato: a
/// value with no abilities that must be consumed in the same transaction by the function it was
/// issued for. `consume` checks the action and the target object, so an attestation for one drop,
/// claim or listing can never be spent on another.
module scalpless::registry;

use sui::bcs;
use sui::clock::Clock;
use sui::ed25519;

const EExpired: u64 = 0;
const EBadSignature: u64 = 1;
const EWrongAction: u64 = 2;
const EWrongTarget: u64 = 3;
const EWrongSubject: u64 = 4;
const EBadKey: u64 = 5;

/// Protocol admin: rotates the verifier key, creates the lending pool.
public struct AdminCap has key, store { id: UID }

public struct Registry has key {
    id: UID,
    verifier_pubkey: vector<u8>,
}

/// What the backend signs. BCS layout must match packages/shared/src/bcs-payload.ts.
public struct AttestationPayload has copy, drop {
    human_key: vector<u8>,
    credential_tier: u8,
    action: vector<u8>,
    target: address,
    subject: address,
    amount: u64,
    expiry_ms: u64,
}

/// A verified attestation, alive only inside the current transaction.
public struct Attested {
    human_key: vector<u8>,
    credential_tier: u8,
    action: vector<u8>,
    target: address,
    subject: address,
    amount: u64,
}

fun init(ctx: &mut TxContext) {
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    transfer::share_object(Registry { id: object::new(ctx), verifier_pubkey: vector[] });
}

public fun set_verifier(_: &AdminCap, registry: &mut Registry, pubkey: vector<u8>) {
    assert!(pubkey.length() == 32, EBadKey);
    registry.verifier_pubkey = pubkey;
}

/// Check the backend's signature over (human, tier, action, target, sender, amount, expiry).
public fun verify(
    registry: &Registry,
    clock: &Clock,
    human_key: vector<u8>,
    credential_tier: u8,
    action: vector<u8>,
    target: address,
    amount: u64,
    expiry_ms: u64,
    signature: vector<u8>,
    ctx: &TxContext,
): Attested {
    assert!(clock.timestamp_ms() <= expiry_ms, EExpired);
    let payload = AttestationPayload {
        human_key,
        credential_tier,
        action,
        target,
        subject: ctx.sender(),
        amount,
        expiry_ms,
    };
    assert!(ed25519::ed25519_verify(&signature, &registry.verifier_pubkey, &bcs::to_bytes(&payload)), EBadSignature);
    let AttestationPayload { human_key, credential_tier, action, target, subject, amount, expiry_ms: _ } = payload;
    Attested { human_key, credential_tier, action, target, subject, amount }
}

/// Spend an attestation on `action` for the object at `target`. Returns (human_key, tier, amount).
public(package) fun consume(
    attested: Attested,
    action: vector<u8>,
    target: address,
    ctx: &TxContext,
): (vector<u8>, u8, u64) {
    let Attested { human_key, credential_tier, action: signed_action, target: signed_target, subject, amount } = attested;
    assert!(signed_action == action, EWrongAction);
    assert!(signed_target == target, EWrongTarget);
    assert!(subject == ctx.sender(), EWrongSubject);
    (human_key, credential_tier, amount)
}

public fun verifier_pubkey(registry: &Registry): vector<u8> { registry.verifier_pubkey }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

#[test_only]
/// Stand-in for a backend-signed attestation in flow tests (signatures are covered separately).
public fun attested_for_testing(
    human_key: vector<u8>,
    credential_tier: u8,
    action: vector<u8>,
    target: address,
    ctx: &TxContext,
): Attested {
    Attested { human_key, credential_tier, action, target, subject: ctx.sender(), amount: 0 }
}
