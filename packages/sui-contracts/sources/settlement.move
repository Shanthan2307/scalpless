/// Settling a won claim: pay in full, or zero-default layaway.
///
/// Layaway: 25% now (the 10% entry deposit counts toward it), then three equal installments.
/// The plan object holds the claim (transfer-to-object) until the last installment, so the buyer
/// never owes anything — a missed installment just refunds them (minus a 5% fee to the seller,
/// routed through their loan first) and the claim passes to the next human on the waitlist.
/// Completing a layaway raises the buyer's credit limit.
module scalpless::settlement;

use scalpless::claim::{Self, Claim};
use scalpless::drop::Drop;
use scalpless::lending::LendingPool;
use scalpless::passport::PassportRegistry;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use sui::transfer::Receiving;

const INSTALLMENTS: u8 = 4;
const DEFAULT_FEE_BPS: u64 = 500;

const ACTIVE: u8 = 0;
const COMPLETE: u8 = 1;
const DEFAULTED: u8 = 2;

const EWrongDrop: u64 = 0;
const EWrongAmount: u64 = 1;
const ENotActive: u64 = 2;
const EPastDue: u64 = 3;
const ENotFullyPaid: u64 = 4;
const ENotOverdue: u64 = 5;
const EWrongClaim: u64 = 6;

public struct LayawayPlan has key {
    id: UID,
    claim_id: ID,
    drop_id: ID,
    buyer: address,
    human_key: vector<u8>,
    seller: address,
    total_mist: u64,
    paid_mist: u64,
    installment_mist: u64,
    installments_paid: u8,
    interval_ms: u64,
    next_due_ms: u64,
    escrow: Balance<SUI>,
    status: u8,
}

public struct PaidInFull has copy, drop { claim_id: ID, human_key: vector<u8>, amount_mist: u64 }
public struct LayawayStarted has copy, drop { plan_id: ID, claim_id: ID, human_key: vector<u8>, installment_mist: u64, next_due_ms: u64 }
public struct InstallmentPaid has copy, drop { plan_id: ID, installments_paid: u8, paid_mist: u64 }
public struct LayawayCompleted has copy, drop { plan_id: ID, claim_id: ID, human_key: vector<u8> }
public struct LayawayDefaulted has copy, drop { plan_id: ID, claim_id: ID, refund_mist: u64, next_holder: Option<address> }

/// Pay the rest of the face price; the entry deposit is applied from the drop vault.
public fun pay_in_full(drop: &mut Drop, claim: &mut Claim, payment: Coin<SUI>, clock: &Clock, ctx: &mut TxContext) {
    claim.assert_holder(ctx);
    claim.assert_status(claim::status_liveness_verified());
    claim.assert_not_expired(clock);
    assert!(object::id(drop) == claim.drop_id(), EWrongDrop);
    assert!(payment.value() == claim.face_price_mist() - claim.deposit_mist(), EWrongAmount);

    let mut total = payment.into_balance();
    total.join(drop.take_deposit(claim.deposit_mist()));
    let amount = total.value();
    transfer::public_transfer(coin::from_balance(total, ctx), claim.seller());
    claim.clear_deposit();
    claim.set_status(claim::status_settled());
    event::emit(PaidInFull { claim_id: object::id(claim), human_key: claim.human_key(), amount_mist: amount });
}

/// Start layaway: pay the first 25% (minus the deposit already held). The claim moves into the plan.
public fun start_layaway(drop: &mut Drop, mut claim: Claim, down_payment: Coin<SUI>, clock: &Clock, ctx: &mut TxContext) {
    claim.assert_holder(ctx);
    claim.assert_status(claim::status_liveness_verified());
    claim.assert_not_expired(clock);
    assert!(object::id(drop) == claim.drop_id(), EWrongDrop);

    let total = claim.face_price_mist();
    let installment = total / (INSTALLMENTS as u64);
    assert!(down_payment.value() == installment - claim.deposit_mist(), EWrongAmount);

    let mut escrow = down_payment.into_balance();
    escrow.join(drop.take_deposit(claim.deposit_mist()));
    claim.clear_deposit();
    claim.set_status(claim::status_in_layaway());

    let interval = drop.installment_interval_ms();
    let plan = LayawayPlan {
        id: object::new(ctx),
        claim_id: object::id(&claim),
        drop_id: object::id(drop),
        buyer: ctx.sender(),
        human_key: claim.human_key(),
        seller: claim.seller(),
        total_mist: total,
        paid_mist: installment,
        installment_mist: installment,
        installments_paid: 1,
        interval_ms: interval,
        next_due_ms: clock.timestamp_ms() + interval,
        escrow,
        status: ACTIVE,
    };
    event::emit(LayawayStarted { plan_id: object::id(&plan), claim_id: plan.claim_id, human_key: plan.human_key, installment_mist: installment, next_due_ms: plan.next_due_ms });
    claim::escrow(claim, object::id_address(&plan));
    transfer::share_object(plan);
}

/// Pay the next installment (the last one also covers rounding). Anyone may pay.
public fun pay_installment(plan: &mut LayawayPlan, payment: Coin<SUI>, clock: &Clock) {
    assert!(plan.status == ACTIVE, ENotActive);
    assert!(plan.installments_paid < INSTALLMENTS, ENotActive);
    assert!(clock.timestamp_ms() <= plan.next_due_ms, EPastDue);
    let due = if (plan.installments_paid == INSTALLMENTS - 1) plan.total_mist - plan.paid_mist else plan.installment_mist;
    assert!(payment.value() == due, EWrongAmount);
    plan.escrow.join(payment.into_balance());
    plan.paid_mist = plan.paid_mist + due;
    plan.installments_paid = plan.installments_paid + 1;
    plan.next_due_ms = plan.next_due_ms + plan.interval_ms;
    event::emit(InstallmentPaid { plan_id: object::id(plan), installments_paid: plan.installments_paid, paid_mist: plan.paid_mist });
}

/// After the last installment: pay the seller, release the claim to the buyer, raise their credit.
public fun complete_layaway(plan: &mut LayawayPlan, preg: &mut PassportRegistry, to_receive: Receiving<Claim>, ctx: &mut TxContext) {
    assert!(plan.status == ACTIVE, ENotActive);
    assert!(plan.paid_mist == plan.total_mist, ENotFullyPaid);
    let mut claim = claim::receive(&mut plan.id, to_receive);
    assert!(object::id(&claim) == plan.claim_id, EWrongClaim);
    plan.status = COMPLETE;
    let payout = plan.escrow.withdraw_all();
    transfer::public_transfer(coin::from_balance(payout, ctx), plan.seller);
    claim.set_status(claim::status_settled());
    preg.record_layaway_completion(plan.human_key);
    event::emit(LayawayCompleted { plan_id: object::id(plan), claim_id: plan.claim_id, human_key: plan.human_key });
    claim::deliver(claim);
}

/// Permissionless once an installment is overdue: refund the buyer (minus 5% to the seller,
/// routed through the buyer's loan first) and pass the claim to the next human on the waitlist.
public fun default_layaway(
    plan: &mut LayawayPlan,
    drop: &mut Drop,
    pool: &mut LendingPool,
    preg: &mut PassportRegistry,
    to_receive: Receiving<Claim>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(plan.status == ACTIVE, ENotActive);
    assert!(plan.installments_paid < INSTALLMENTS && clock.timestamp_ms() > plan.next_due_ms, ENotOverdue);
    assert!(object::id(drop) == plan.drop_id, EWrongDrop);
    let mut claim = claim::receive(&mut plan.id, to_receive);
    assert!(object::id(&claim) == plan.claim_id, EWrongClaim);
    plan.status = DEFAULTED;

    let mut refund = coin::from_balance(plan.escrow.withdraw_all(), ctx);
    let fee = refund.value() * DEFAULT_FEE_BPS / 10_000;
    transfer::public_transfer(refund.split(fee, ctx), plan.seller);
    let refund_amount = refund.value();
    pool.route_income(preg, plan.human_key, refund, plan.buyer);

    let next = drop.pop_waitlist();
    let next_holder = if (next.is_some()) {
        let e = next.destroy_some();
        let holder = e.entry_beneficiary();
        claim.reassign(holder, e.entry_human_key(), claim::status_won(), clock.timestamp_ms() + drop.claim_window_ms());
        claim::deliver(claim);
        option::some(holder)
    } else {
        next.destroy_none();
        claim::destroy(claim);
        option::none()
    };
    event::emit(LayawayDefaulted { plan_id: object::id(plan), claim_id: plan.claim_id, refund_mist: refund_amount, next_holder });
}

public fun plan_claim_id(plan: &LayawayPlan): ID { plan.claim_id }
public fun plan_paid_mist(plan: &LayawayPlan): u64 { plan.paid_mist }
public fun plan_status(plan: &LayawayPlan): u8 { plan.status }
public fun plan_installments_paid(plan: &LayawayPlan): u8 { plan.installments_paid }
