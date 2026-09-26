import { bcs } from '@mysten/sui/bcs';

// Must match `scalpless::registry::AttestationPayload` field-for-field (BCS is positional).
export interface AttestationPayloadData {
  human_key: Uint8Array | number[];
  credential_tier: number;
  action: string;
  /// Object the attestation may be spent on (drop, claim, passport registry, agent address).
  target: string;
  /// Sui address that must send the transaction.
  subject: string;
  amount: bigint | number;
  expiry_ms: bigint | number;
}

export const AttestationPayloadBcs = bcs.struct('AttestationPayload', {
  human_key: bcs.vector(bcs.u8()),
  credential_tier: bcs.u8(),
  action: bcs.vector(bcs.u8()),
  target: bcs.Address,
  subject: bcs.Address,
  amount: bcs.u64(),
  expiry_ms: bcs.u64(),
});

export function serializeAttestationPayload(data: AttestationPayloadData): Uint8Array {
  return AttestationPayloadBcs.serialize({
    human_key: Array.from(data.human_key),
    credential_tier: data.credential_tier,
    action: Array.from(new TextEncoder().encode(data.action)),
    target: data.target,
    subject: data.subject,
    amount: BigInt(data.amount),
    expiry_ms: BigInt(data.expiry_ms),
  }).toBytes();
}
