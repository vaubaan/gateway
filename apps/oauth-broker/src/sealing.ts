/**
 * Refresh tokens sealed to their instance (ADR
 * oauth-broker-stateless-in-an-attested-enclave, amendment "review"). The
 * redeem answers the provider's refresh token as an opaque blob:
 *
 *   v1.<base64url(iv 12 bytes | AES-256-GCM ciphertext | tag 16 bytes)>
 *
 * with the instance's enrollment id and the provider as additional data. The
 * broker opens it only for the instance that authenticates with the same
 * enrollment id: a blob stolen from one instance's store is worthless with
 * another instance's key, and every blob of an instance dies when it is
 * unenrolled. The key (32 bytes) is unsealed at start by the platform
 * adapter, like the client secret, and never leaves the process.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformError } from './platform/types.ts';

/** The name the platform adapter unseals the key by (Secret Manager in Confidential Space). */
export const SEALING_KEY_SECRET = 'refresh-token-sealing-key';
const KEY_ID = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BLOB = /^v1\.[A-Za-z0-9_-]{40,8192}$/;

/** The key as the secret holds it: 32 bytes in base64 (or base64url). */
export function parseSealingKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== 32) {
    throw new PlatformError('the refresh-token sealing key must be 32 bytes in base64');
  }
  return key;
}

function aad(instanceId: string, provider: string): Buffer {
  return Buffer.from(`${KEY_ID}|${instanceId}|${provider}`, 'utf8');
}

export class TokenSealer {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new PlatformError('the sealing key must be 32 bytes');
    this.#key = key;
  }

  seal(instanceId: string, provider: string, token: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(instanceId, provider));
    const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return `${KEY_ID}.${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url')}`;
  }

  /** The token, or undefined for another instance, another provider or a tampered blob. */
  open(instanceId: string, provider: string, blob: string): string | undefined {
    if (!BLOB.test(blob)) return undefined;
    const raw = Buffer.from(blob.slice(KEY_ID.length + 1), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(instanceId, provider));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      return undefined;
    }
  }
}
