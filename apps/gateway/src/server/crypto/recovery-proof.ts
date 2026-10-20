/**
 * The proof of holding the master key for the recovery page (ADR
 * administrators-live-in-the-instance §9): `HKDF-SHA-256(key, salt "", info
 * "vaubaan/recovery-proof/v1")`, then `HMAC-SHA-256` of
 * `"vaubaan-recovery-v1\n" + origin + "\n" + challenge`, base64url. The page computes
 * the same with Web Crypto (`components/auth/recovery-proof.ts`); a test holds them equal.
 */
import { createHmac, hkdfSync } from 'node:crypto';

export const RECOVERY_INFO = 'vaubaan/recovery-proof/v1';
export const RECOVERY_MESSAGE_PREFIX = 'vaubaan-recovery-v1';

export function recoveryProof(masterKey: Uint8Array, origin: string, challenge: string): string {
  const key = Buffer.from(hkdfSync('sha256', masterKey, new Uint8Array(0), RECOVERY_INFO, 32));
  return createHmac('sha256', key)
    .update(`${RECOVERY_MESSAGE_PREFIX}\n${origin}\n${challenge}`)
    .digest('base64url');
}
