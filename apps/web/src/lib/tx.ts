// Transaction builders — one per protocol action. Actions that need World ID start with
// registry::verify (checks the backend's Ed25519 attestation) and pass the resulting `Attested`
// hot potato into the protocol call in the same transaction.
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import type { Attestation } from '../components/world/WorldIdProvider';
import {
  CALL_PACKAGE_ID,
  REGISTRY_OBJECT_ID,
  PASSPORT_REGISTRY_ID,
  LENDING_POOL_OBJECT_ID,
  MARKET_OBJECT_ID,
  CLOCK_OBJECT_ID,
  RANDOM_OBJECT_ID,
} from './constants';
import { SENIOR_LP_TYPE, JUNIOR_LP_TYPE } from './chain';

const fn = (module: string, name: string) => `${CALL_PACKAGE_ID}::${module}::${name}` as const;

function verify(tx: Transaction, a: Attestation) {
  const [attested] = tx.moveCall({
    target: fn('registry', 'verify'),
    arguments: [
      tx.object(REGISTRY_OBJECT_ID),
      tx.object(CLOCK_OBJECT_ID),
      tx.pure.vector('u8', Array.from(fromHex(a.nullifier_hex))),
      tx.pure.u8(a.credential_tier),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(a.action))),
      tx.pure.address(a.target),
      tx.pure.u64(0),
      tx.pure.u64(BigInt(a.attestation.expiry_ms)),
      tx.pure.vector('u8', a.attestation.signatureBytes),
    ],
  });
  return attested;
}

// ---- identity -----------------------------------------------------------------------------------

export function mintPassportTx(a: Attestation) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('passport', 'register'), arguments: [tx.object(PASSPORT_REGISTRY_ID), verify(tx, a)] });
  return tx;
}

export function delegateAgentTx(a: Attestation, agent: string) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('passport', 'delegate_agent'), arguments: [tx.object(PASSPORT_REGISTRY_ID), verify(tx, a), tx.pure.address(agent)] });
  return tx;
}

export function revokeAgentTx(agent: string) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('passport', 'revoke_agent'), arguments: [tx.object(PASSPORT_REGISTRY_ID), tx.pure.address(agent)] });
  return tx;
}

// ---- drops --------------------------------------------------------------------------------------

export function createDropTx(p: {
  title: string;
  facePriceMist: bigint;
  units: number;
  minTier: number;
  entryDeadlineMs: number;
  claimWindowMs: number;
  installmentIntervalMs: number;
}) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('drop', 'create_drop'),
    arguments: [
      tx.pure.string(p.title),
      tx.pure.u64(p.facePriceMist),
      tx.pure.u64(p.units),
      tx.pure.u8(p.minTier),
      tx.pure.u64(p.entryDeadlineMs),
      tx.pure.u64(p.claimWindowMs),
      tx.pure.u64(p.installmentIntervalMs),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function enterDropTx(a: Attestation, dropId: string, depositMist: bigint) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('drop', 'enter'),
    arguments: [tx.object(dropId), tx.object(PASSPORT_REGISTRY_ID), verify(tx, a), coinWithBalance({ balance: depositMist }), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function executeDrawTx(dropId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('drop', 'execute_draw'),
    arguments: [tx.object(dropId), tx.object(PASSPORT_REGISTRY_ID), tx.object(RANDOM_OBJECT_ID), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

// ---- claims & settlement --------------------------------------------------------------------

export function verifyLivenessTx(a: Attestation, claimId: string) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('claim', 'verify_liveness'), arguments: [tx.object(claimId), verify(tx, a), tx.object(CLOCK_OBJECT_ID)] });
  return tx;
}

export function payInFullTx(dropId: string, claimId: string, amountMist: bigint) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('settlement', 'pay_in_full'),
    arguments: [tx.object(dropId), tx.object(claimId), coinWithBalance({ balance: amountMist }), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function startLayawayTx(dropId: string, claimId: string, downMist: bigint) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('settlement', 'start_layaway'),
    arguments: [tx.object(dropId), tx.object(claimId), coinWithBalance({ balance: downMist }), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function payInstallmentTx(planId: string, amountMist: bigint) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('settlement', 'pay_installment'), arguments: [tx.object(planId), coinWithBalance({ balance: amountMist }), tx.object(CLOCK_OBJECT_ID)] });
  return tx;
}

export function completeLayawayTx(planId: string, claimId: string) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('settlement', 'complete_layaway'), arguments: [tx.object(planId), tx.object(PASSPORT_REGISTRY_ID), tx.object(claimId)] });
  return tx;
}

export function defaultLayawayTx(planId: string, dropId: string, claimId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('settlement', 'default_layaway'),
    arguments: [tx.object(planId), tx.object(dropId), tx.object(LENDING_POOL_OBJECT_ID), tx.object(PASSPORT_REGISTRY_ID), tx.object(claimId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

// ---- lending ------------------------------------------------------------------------------------

export function borrowTx(dropId: string, claimId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('lending', 'borrow_for_claim'),
    arguments: [tx.object(LENDING_POOL_OBJECT_ID), tx.object(dropId), tx.object(claimId), tx.object(PASSPORT_REGISTRY_ID), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function repayTx(humanKeyHex: string, amountMist: bigint, sender: string) {
  const tx = new Transaction();
  const [change] = tx.moveCall({
    target: fn('lending', 'repay'),
    arguments: [tx.object(LENDING_POOL_OBJECT_ID), tx.object(PASSPORT_REGISTRY_ID), tx.pure.vector('u8', Array.from(fromHex(humanKeyHex))), coinWithBalance({ balance: amountMist })],
  });
  tx.transferObjects([change], sender);
  return tx;
}

export function markTx(kind: 'mark_late' | 'mark_default', humanKeyHex: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('lending', kind),
    arguments: [tx.object(LENDING_POOL_OBJECT_ID), tx.object(PASSPORT_REGISTRY_ID), tx.pure.vector('u8', Array.from(fromHex(humanKeyHex))), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function depositTx(tranche: 'senior' | 'junior', amountMist: bigint, sender: string) {
  const tx = new Transaction();
  const [lp] = tx.moveCall({ target: fn('lending', `deposit_${tranche}`), arguments: [tx.object(LENDING_POOL_OBJECT_ID), coinWithBalance({ balance: amountMist })] });
  tx.transferObjects([lp], sender);
  return tx;
}

export function withdrawTx(tranche: 'senior' | 'junior', shares: bigint, sender: string) {
  const tx = new Transaction();
  const type = tranche === 'senior' ? SENIOR_LP_TYPE : JUNIOR_LP_TYPE;
  const [out] = tx.moveCall({ target: fn('lending', `withdraw_${tranche}`), arguments: [tx.object(LENDING_POOL_OBJECT_ID), coinWithBalance({ type, balance: shares })] });
  tx.transferObjects([out], sender);
  return tx;
}

// ---- market -------------------------------------------------------------------------------------

export function listTx(claimId: string, askMist: bigint) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('market', 'list'), arguments: [tx.object(MARKET_OBJECT_ID), tx.object(claimId), tx.pure.u64(askMist)] });
  return tx;
}

export function delistTx(claimId: string) {
  const tx = new Transaction();
  tx.moveCall({ target: fn('market', 'delist'), arguments: [tx.object(MARKET_OBJECT_ID), tx.object(claimId)] });
  return tx;
}

export function buyTx(a: Attestation, claimId: string, priceMist: bigint) {
  const tx = new Transaction();
  tx.moveCall({
    target: fn('market', 'buy'),
    arguments: [
      tx.object(MARKET_OBJECT_ID),
      tx.object(LENDING_POOL_OBJECT_ID),
      tx.object(PASSPORT_REGISTRY_ID),
      verify(tx, a),
      tx.object(claimId),
      coinWithBalance({ balance: priceMist }),
    ],
  });
  return tx;
}

