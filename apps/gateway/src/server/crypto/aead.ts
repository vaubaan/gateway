/**
 * AEAD core — XChaCha20-Poly1305 (libsodium), moved from the v4
 * `web/lib/crypto/service-secrets.ts` and adapted to v5 (spec §6):
 *
 * - the key is derived **per account** from a master key with a keyed
 *   BLAKE2b hash of the account id (`crypto_generichash`), so two
 *   accounts never share a key;
 * - the account id is also the **associated data**, so a blob moved to
 *   another account row fails to open;
 * - the blob is `format(1) || nonce(24) || ciphertext`. The master key
 *   version is not inside the blob: the store keeps it in a `key_version`
 *   column next to the blob (see `Encryptor`).
 *
 * Every function here is synchronous and requires `await sodiumReady()`
 * once per process; `createEncryptor()` does that for its callers.
 */
import sodium from 'libsodium-wrappers-sumo';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const BLOB_FORMAT_V1 = 0x01;
/**
 * Fed to the KDF before the account id: these bytes derive the key of every stored
 * credential. They keep the word of the time they were chosen ("connection", ADR
 * one-word-per-thing-account-service-plugin) and never change: another string would
 * derive other keys, and no stored credential would open.
 */
const KDF_CONTEXT = 'vaubaan/connection-key/v1:';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export async function sodiumReady(): Promise<void> {
  await sodium.ready;
}

export function assertKeyLength(key: Uint8Array, what: string): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(`${what} must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

/** Per-account subkey: BLAKE2b(context || accountId) keyed with the master key. */
export function deriveAccountKey(masterKey: Uint8Array, accountId: string): Uint8Array {
  assertKeyLength(masterKey, 'master key');
  if (accountId.length === 0) throw new CryptoError('account id must not be empty');
  const input = new TextEncoder().encode(KDF_CONTEXT + accountId);
  return sodium.crypto_generichash(KEY_BYTES, input, masterKey);
}

export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  assertKeyLength(key, 'account key');
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
  const blob = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  blob[0] = BLOB_FORMAT_V1;
  blob.set(nonce, 1);
  blob.set(ciphertext, 1 + NONCE_BYTES);
  return blob;
}

export function open(key: Uint8Array, blob: Uint8Array, associatedData: Uint8Array): Uint8Array {
  assertKeyLength(key, 'account key');
  if (blob.length < 1 + NONCE_BYTES + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new CryptoError('ciphertext too short');
  }
  if (blob[0] !== BLOB_FORMAT_V1) {
    throw new CryptoError(`unknown blob format ${String(blob[0])}`);
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = blob.subarray(1 + NONCE_BYTES);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData,
      nonce,
      key,
    );
  } catch {
    // libsodium's message is generic on purpose; so is ours (no oracle).
    throw new CryptoError('decryption failed: wrong key, wrong account or tampered blob');
  }
}

export function wipe(bytes: Uint8Array): void {
  sodium.memzero(bytes);
}
