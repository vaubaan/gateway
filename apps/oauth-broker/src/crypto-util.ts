import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** `bytes` of randomness, base64url without padding. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** BASE64URL(SHA-256(ascii)) — the PKCE S256 transform (RFC 7636 §4.2). */
export function s256(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant time for equal lengths; different lengths are simply unequal. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = typeof a === 'string' ? Buffer.from(a) : a;
  const right = typeof b === 'string' ? Buffer.from(b) : b;
  return left.length === right.length && timingSafeEqual(left, right);
}
