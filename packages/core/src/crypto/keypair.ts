import { getSodium } from './sodium.js';

const FINGERPRINT_BYTES = 16;

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  // Web Crypto is available on Node 20+ (`globalThis.crypto.subtle`) and
  // every evergreen browser. libsodium-wrappers 0.7.x doesn't surface
  // `crypto_hash_sha256` (it would be SHA-512 via `crypto_hash`), so we
  // use the platform SHA-256 here. Spec §4.1 mandates SHA-256.
  // Copy into a fresh Uint8Array<ArrayBuffer> so DOM typings accept it
  // (libsodium returns Uint8Array<ArrayBufferLike>, which is a
  // SharedArrayBuffer-superset that `crypto.subtle.digest` refuses).
  const copy = new Uint8Array(input);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(buf);
}

export interface UserKeypair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly fingerprint: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Generates a fresh X25519 keypair (spec §4.1). The returned `privateKey`
 * is the secret scalar — callers must wrap it before persisting (see
 * `wrap.ts`) and never log or transmit it in clear.
 */
export async function generateUserKeypair(): Promise<UserKeypair> {
  const sodium = await getSodium();
  const kp = sodium.crypto_box_keypair();
  const fingerprint = await fingerprintOf(kp.publicKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    fingerprint,
  };
}

/**
 * Computes the on-disk fingerprint of an X25519 public key:
 * sha256(publicKey) truncated to the first 16 bytes, hex-encoded
 * (32 chars). Matches spec §4.1.
 */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  const digest = await sha256(publicKey);
  return bytesToHex(digest.slice(0, FINGERPRINT_BYTES));
}
