import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { env } from '../config/env';
import { serializeAttestationPayload } from '../../../../packages/shared/src/bcs-payload';

export interface SignAttestationParams {
  human_key: string; // hex
  credential_tier: number;
  action: string;
  target: string; // Sui address / object id the attestation may be spent on
  subject: string; // Sui address that must send the transaction
  amount?: bigint | number;
  expiry_ms: bigint | number;
}

export interface AttestationResult {
  signatureHex: string;
  signatureBytes: number[];
  payloadBytes: number[];
  verifierPubkeyHex: string;
  expiry_ms: string;
}

export class AttestationService {
  private keypair: Ed25519Keypair;

  constructor() {
    const key = env.ATTESTATION_SIGNER_KEY.startsWith('0x') ? env.ATTESTATION_SIGNER_KEY.slice(2) : env.ATTESTATION_SIGNER_KEY;
    if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('[env] ATTESTATION_SIGNER_KEY must be 32 bytes of hex');
    this.keypair = Ed25519Keypair.fromSecretKey(Buffer.from(key, 'hex'));
  }

  getPublicKeyHex(): string {
    return Buffer.from(this.keypair.getPublicKey().toRawBytes()).toString('hex');
  }

  getPublicKeyBytes(): number[] {
    return Array.from(this.keypair.getPublicKey().toRawBytes());
  }

  async signAttestation(params: SignAttestationParams): Promise<AttestationResult> {
    const serialized = serializeAttestationPayload({
      human_key: Buffer.from(params.human_key.replace(/^0x/, ''), 'hex'),
      credential_tier: params.credential_tier,
      action: params.action,
      target: params.target,
      subject: params.subject,
      amount: params.amount ?? 0n,
      expiry_ms: params.expiry_ms,
    });
    const sig = await this.keypair.sign(serialized);
    return {
      signatureHex: Buffer.from(sig).toString('hex'),
      signatureBytes: Array.from(sig),
      payloadBytes: Array.from(serialized),
      verifierPubkeyHex: this.getPublicKeyHex(),
      expiry_ms: params.expiry_ms.toString(),
    };
  }
}

export const attestationService = new AttestationService();
