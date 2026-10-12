/**
 * AEAD core — XChaCha20-Poly1305 (libsodium), moved from the v4
 * `web/lib/crypto/provider-secrets.ts` and adapted to v5 (spec §6):
 *
 * - the key is derived **per connection** from a master key with a keyed
 *   BLAKE2b hash of the connection id (`crypto_generichash`), so two
 *   connections never share a key;
 * - the connection id is also the **associated data**, so a blob moved to
 *   another connection row fails to open;
 * - the blob is `format(1) || nonce(24) || ciphertext`. The master key
 *   version is not inside the blob: the store keeps it in a `key_version`
 *   column next to the blob (see `Encryptor`).
 *
 * Every function here is synchronous and requires `await sodiumReady()`
 * once per process; `createEncryptor()` does that for its callers.
 */
import sodium from 'libsodium-wrappers';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const BLOB_FORMAT_V1 = 0x01;
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

/** Per-connection subkey: BLAKE2b(context || connectionId) keyed with the master key. */
export function deriveConnectionKey(masterKey: Uint8Array, connectionId: string): Uint8Array {
  assertKeyLength(masterKey, 'master key');
  if (connectionId.length === 0) throw new CryptoError('connection id must not be empty');
  const input = new TextEncoder().encode(KDF_CONTEXT + connectionId);
  return sodium.crypto_generichash(KEY_BYTES, input, masterKey);
}

export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  assertKeyLength(key, 'connection key');
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
  assertKeyLength(key, 'connection key');
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
    throw new CryptoError('decryption failed: wrong key, wrong connection or tampered blob');
  }
}

export function wipe(bytes: Uint8Array): void {
  sodium.memzero(bytes);
}
