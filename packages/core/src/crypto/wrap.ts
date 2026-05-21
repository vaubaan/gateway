import { getSodium } from './sodium.js';

const NONCE_BYTES = 24;

/**
 * Wraps the user's X25519 private key with the KEK derived from their
 * password (spec §4.1, ADR libsodium-sealed-box-multi-recipient). Output
 * layout: `nonce (24 bytes) || ciphertext`, returned as a single
 * `Uint8Array` ready to persist as `user_crypto_keys.wrapped_private_key`.
 */
export async function wrapPrivateKey(sk: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_secretbox_easy(sk, nonce, kek);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/**
 * Reverses `wrapPrivateKey`. Returns `null` on any failure (wrong KEK,
 * tampered ciphertext, malformed input) — never throws and never leaks
 * the cleartext via an error message.
 */
export async function unwrapPrivateKey(
  wrapped: Uint8Array,
  kek: Uint8Array,
): Promise<Uint8Array | null> {
  if (wrapped.length <= NONCE_BYTES) return null;
  const sodium = await getSodium();
  const nonce = wrapped.subarray(0, NONCE_BYTES);
  const ct = wrapped.subarray(NONCE_BYTES);
  try {
    return sodium.crypto_secretbox_open_easy(ct, nonce, kek);
  } catch {
    return null;
  }
}
