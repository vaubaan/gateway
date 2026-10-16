/**
 * Encryptor port — the master-key crypto the store uses for encrypted blobs.
 *
 * The contract is the `Encryptor` of the crypto module (
 * `apps/gateway/src/server/crypto/encryptor.ts`): XChaCha20-Poly1305 with a key derived
 * from the master key per blob and the blob's identifier as associated data, plus a
 * `keyVersion` for rotation. The store depends on the type only; the composition root
 * injects the instance.
 *
 * The crypto module names its first argument `connectionId` because connections were
 * its first use; the store passes the identifier of whatever row owns the blob —
 * the connection id, `request:<id>` for approval arguments, `instance_config:<key>`
 * for configuration secrets — so a blob cannot be moved from one row to another.
 *
 * The port is asynchronous and better-sqlite3 transactions are synchronous: every
 * repository seals before it opens its transaction and opens after it closes.
 */

import type { EncryptedBlob, Encryptor } from '../crypto/encryptor.ts';

export type { EncryptedBlob, Encryptor };

/** What the store persists: the blob and the master-key version that sealed it. */
export interface SealedBlob {
  readonly blob: Buffer;
  readonly keyVersion: number;
}

export async function sealText(
  encryptor: Encryptor,
  associatedData: string,
  text: string,
): Promise<SealedBlob> {
  const { blob, keyVersion } = await encryptor.encrypt(associatedData, text);
  return { blob: Buffer.from(blob), keyVersion };
}

export async function openText(
  encryptor: Encryptor,
  associatedData: string,
  sealed: SealedBlob,
): Promise<string> {
  return encryptor.decrypt(associatedData, { keyVersion: sealed.keyVersion, blob: sealed.blob });
}

/**
 * Opens an encrypted column pair as the repositories store it: `null` when the row holds
 * no blob (or no key version), the clear text otherwise. One place for the null rule.
 */
export async function openSealedColumn(
  encryptor: Encryptor,
  associatedData: string,
  blob: Buffer | null,
  keyVersion: number | null,
): Promise<string | null> {
  if (!blob || keyVersion === null) return null;
  return openText(encryptor, associatedData, { blob, keyVersion });
}
