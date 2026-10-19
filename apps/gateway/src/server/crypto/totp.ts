/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226) and recovery codes,
 * for the second factor of the local accounts (ADR
 * local-accounts-sign-in-provider). Forty lines over `node:crypto`: HMAC-SHA-1,
 * six digits, thirty-second steps — what every authenticator app does by
 * default — and base32 (RFC 4648) for the secret in the `otpauth://` URL.
 *
 * Replay is the caller's business: `verifyTotp` returns the time step the code
 * matched, and the store refuses a step that is not later than the last one
 * accepted (`LocalAccountsRepo.advanceTotpStep`).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step of drift each way: a code typed just as the step turned over still counts. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, as RFC 4226 recommends. */
const SECRET_BYTES = 20;
export const RECOVERY_CODE_COUNT = 8;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive, spaces and `=` padding ignored; `null` on any other character. */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new secret, base32 (what the QR code and the "type it by hand" box carry). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function totpStepOf(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code of one time step (RFC 4226 §5.3, dynamic truncation). */
export function totpCode(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 2 ** 24 +
    ((digest[offset + 1] ?? 0) & 0xff) * 2 ** 16 +
    ((digest[offset + 2] ?? 0) & 0xff) * 2 ** 8 +
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The time step `code` is the code of, within the drift around `nowMs`, or `null`.
 * Compared in constant time per candidate; every candidate is tried (no early exit
 * on the step that matches).
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const current = totpStepOf(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_DRIFT_STEPS; delta <= TOTP_DRIFT_STEPS; delta += 1) {
    const step = current + delta;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(typed))) {
      matched = step;
    }
  }
  return matched;
}

/** The `otpauth://totp/` URL an authenticator app enrols from. */
export function otpauthUrl(input: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: string;
}): string {
  const label = `${input.issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** Eight codes of ten lower-case base32 characters, in two groups: `k7m2p-x4q9z`. */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** The form a recovery code is compared in: lower-case, without spaces or hyphens. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

export function recoveryCodeDigest(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}
