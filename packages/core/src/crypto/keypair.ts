import { getSodium } from './sodium.js';

const FINGERPRINT_BYTES = 16;

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  // Web Crypto is available on Node 20+ (`globalThis.crypto.subtle`) and
  // every evergreen browser. libsodium-wrappers 0.7.x doesn't surface
  // `crypto_hash_sha256` (it would be SHA-512 via `crypto_hash`), so we
  // use the platform SHA-256 here. Spec §4.1 mandates SHA-256.
  // The `unknown` indirection works around a TS 5.x typed-array generic
  // that fires only when this file is type-checked under the DOM lib
  // (e.g. `@crm/web` resolving an import): `subtle.digest` expects an
  // `ArrayBuffer`-backed view but TS infers `Uint8Array<ArrayBufferLike>`.
  // The runtime accepts any `Uint8Array`; it's purely a type-level coercion.
  // ESLint sees this file under core's ES2022 tsconfig where the assertion
  // is redundant — hence the targeted disable.
  const buf = await globalThis.crypto.subtle.digest(
    'SHA-256',
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    input as unknown as ArrayBuffer,
  );
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
