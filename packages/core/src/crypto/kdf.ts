import { getSodium } from './sodium.js';

export interface KdfParams {
  /** Memory cost in bytes (Argon2id `m`). Default: 64 MiB = 67108864. */
  readonly m: number;
  /** Iteration count (Argon2id `t`). Default: 3. */
  readonly t: number;
  /** Parallelism (Argon2id `p`). Default: 1. */
  readonly p: number;
}

const DEFAULT_PARAMS: KdfParams = { m: 67108864, t: 3, p: 1 };
const KEK_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Derives a 32-byte KEK from the user password and a per-user salt via
 * Argon2id (spec §4.1). Refuses params weaker than the spec defaults
 * and refuses non-16-byte salts.
 */
export async function deriveKEK(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_PARAMS,
): Promise<Uint8Array> {
  if (salt.length !== SALT_LENGTH) {
    throw new Error(
      `argon2id salt must be ${String(SALT_LENGTH)} bytes (got ${String(salt.length)})`,
    );
  }
  if (params.m < DEFAULT_PARAMS.m || params.t < DEFAULT_PARAMS.t || params.p < DEFAULT_PARAMS.p) {
    throw new Error('argon2id params too weak: spec §4.1 requires at least m=64MiB, t=3, p=1');
  }
  const sodium = await getSodium();
  return sodium.crypto_pwhash(
    KEK_LENGTH,
    password,
    salt,
    params.t,
    params.m,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}
