/**
 * Password hashing of the local accounts (spec §6; ADR
 * local-accounts-sign-in-provider): argon2id through libsodium's
 * `crypto_pwhash_str`, which writes a self-describing string (algorithm, salt,
 * limits) so that the limits can be raised later without a migration — a hash
 * verifies with the limits it was made with.
 *
 * Interactive limits (64 MiB, 2 passes): a fraction of a second on a small
 * instance, and the sign-in form is rate-limited and locks an account after
 * repeated failures (`local-accounts.ts`). The hash is computed synchronously
 * by the WebAssembly build: the event loop waits that long, which is the point.
 *
 * The policy is a length, not a composition: at least `PASSWORD_MIN_LENGTH`
 * characters, at most `PASSWORD_MAX_BYTES` bytes (argon2's input limit is far
 * higher; the cap keeps a pathological password from costing more than the
 * hash).
 */
import sodium from 'libsodium-wrappers-sumo';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 256;

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
  await sodium.ready;
  return sodium.crypto_pwhash_str(
    password,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  );
}

/** Whether `password` is the one `hash` was made from; `false` for a malformed hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  await sodium.ready;
  try {
    return sodium.crypto_pwhash_str_verify(hash, password);
  } catch {
    return false;
  }
}

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
