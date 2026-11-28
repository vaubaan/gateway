/**
 * Password hashing of the sign-in accounts (spec §6; ADR
 * local-accounts-sign-in-provider): argon2id in the PHC string format
 * (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`), which names its algorithm, salt and
 * limits, so that the limits can be raised later without a migration — a hash
 * verifies with the limits it was made with.
 *
 * Interactive limits (64 MiB, 2 passes, one lane, 32-byte hash, 16-byte salt):
 * libsodium's `crypto_pwhash_str` limits, which wrote the hashes stored before
 * (security audit 2026-10-31, M2). Those hashes are the same format and verify
 * unchanged; a new hash is written with its parameters in libsodium's order
 * (`m,t,p`), so an earlier image still verifies a password set by this one. The
 * native `argon2` binding computes off the event loop, on libuv's thread pool: a
 * sign-in being hashed no longer stalls every other request (the MCP calls of
 * running agents included). The sign-in form stays rate-limited
 * (`AUTH_LIMITS.password*`) and locks an account after repeated failures
 * (`sign-in-accounts.ts`), which bounds how much of the pool anonymous posts take.
 *
 * The policy is a length, not a composition: at least `PASSWORD_MIN_LENGTH`
 * characters, at most `PASSWORD_MAX_BYTES` bytes (argon2's input limit is far
 * higher; the cap keeps a pathological password from costing more than the
 * hash).
 */
import argon2 from 'argon2';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 256;

const KIB_PER_MIB = 1024;

/** The limits every new hash is made with. */
export const PASSWORD_HASH_LIMITS = {
  type: argon2.argon2id,
  memoryCost: 64 * KIB_PER_MIB,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

/** Why a password is refused, in one sentence for the form, or `null`. */
export function passwordProblem(password: string): string | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    return `The password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `The password must be at most ${PASSWORD_MAX_BYTES} bytes long.`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return inLibsodiumOrder(await argon2.hash(password, PASSWORD_HASH_LIMITS));
}

/**
 * The PHC string with its parameters as `m=…,t=…,p=…`: the binding writes `m,p,t`,
 * which libsodium's parser (the earlier images) refuses. Both orders verify here.
 */
function inLibsodiumOrder(phc: string): string {
  const fields = phc.split('$');
  const params = new Map<string, string>();
  for (const pair of (fields[3] ?? '').split(',')) {
    const [key, value] = pair.split('=');
    if (key && value) params.set(key, value);
  }
  const m = params.get('m');
  const t = params.get('t');
  const p = params.get('p');
  if (fields.length !== 6 || params.size !== 3 || !m || !t || !p) {
    throw new Error('argon2 returned a hash of an unexpected shape');
  }
  fields[3] = `m=${m},t=${t},p=${p}`;
  return fields.join('$');
}

/** Whether `password` is the one `hash` was made from; `false` for a malformed hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // expected: argon2 throws on a malformed hash, which verifies nothing
    return false;
  }
}

/** The hashing a service is handed (the native binding in production). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** Verifies against a hash nobody's password matches: the cost of a check, the answer "no". */
  verifyDecoy(password: string): Promise<boolean>;
}

export const argon2Passwords: PasswordHasher = {
  hash: hashPassword,
  verify: verifyPassword,
  verifyDecoy: async (password) => verifyPassword(await decoyHash(), password),
};

/**
 * A hash to verify a wrong address against, so that "unknown address" and
 * "wrong password" cost the same time (no enumeration by timing). Computed once
 * per process, lazily.
 */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword('not-a-password-anyone-holds');
  return decoy;
}
