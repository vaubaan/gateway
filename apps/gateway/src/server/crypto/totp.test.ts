import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  recoveryCodeDigest,
  totpCode,
  totpStepOf,
  verifyTotp,
} from './totp';

/** RFC 6238 appendix B: the secret "12345678901234567890", SHA-1, six last digits. */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const RFC_VECTORS: readonly [number, string][] = [
  [59, '287082'],
  [1_111_111_109, '081804'],
  [1_111_111_111, '050471'],
  [1_234_567_890, '005924'],
  [2_000_000_000, '279037'],
  [20_000_000_000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('reproduces the test vectors of the RFC', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, totpStepOf(seconds * 1000))).toBe(code);
    }
  });

  it('verifies a code of the current step and of one step each way, not two', () => {
    const now = 1_111_111_111 * 1000;
    expect(verifyTotp(RFC_SECRET, '050471', now)).toBe(totpStepOf(now));
    expect(verifyTotp(RFC_SECRET, '081804', now)).toBe(totpStepOf(now) - 1); // 1111111109 is the previous step
    expect(verifyTotp(RFC_SECRET, ' 050 471 ', now)).toBe(totpStepOf(now));
    expect(verifyTotp(RFC_SECRET, '287082', now)).toBeNull(); // the code of step 1
    expect(verifyTotp(RFC_SECRET, '05047', now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
  });

  it('base32 round-trips and tolerates case, spaces and padding', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const bytes = base32Decode(secret);
    expect(bytes).not.toBeNull();
    expect(base32Encode(bytes ?? new Uint8Array())).toBe(secret);
    expect(base32Decode(`${secret.toLowerCase().slice(0, 8)} ${secret.slice(8)}==`)).toEqual(bytes);
    expect(base32Decode('not base32!')).toBeNull();
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });

  it('writes the otpauth URL an authenticator app expects', () => {
    const url = otpauthUrl({ issuer: 'Acme gateway', account: 'ada@example.com', secret: 'ABCD' });
    expect(url).toBe(
      'otpauth://totp/Acme%20gateway%3Aada%40example.com?secret=ABCD&issuer=Acme+gateway&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('makes eight distinct recovery codes, compared without case, spaces or hyphens', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    const [first = ''] = codes;
    expect(normalizeRecoveryCode(first.toUpperCase().replace('-', ' '))).toBe(
      first.replace('-', ''),
    );
    expect(recoveryCodeDigest(first.toUpperCase())).toBe(recoveryCodeDigest(first));
  });
});
