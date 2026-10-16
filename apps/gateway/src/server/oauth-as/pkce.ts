/**
 * PKCE (RFC 7636), `S256` only: the `plain` method is never accepted, and an
 * authorization request without a challenge is refused (OAuth 2.1).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** base64url of a SHA-256: exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isCodeChallenge(value: string): boolean {
  return CHALLENGE.test(value);
}

export function isCodeVerifier(value: string): boolean {
  return VERIFIER.test(value);
}

/** The S256 challenge of a verifier. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Whether `verifier` is the secret behind `challenge`. A malformed verifier or
 * challenge never matches; the comparison of the two digests is constant-time.
 */
export function verifyS256(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  const computed = Buffer.from(challengeOf(verifier), 'ascii');
  const expected = Buffer.from(challenge, 'ascii');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
