import { describe, expect, it } from 'vitest';

import {
  decoyHash,
  hashPassword,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('hashes with argon2id and verifies the password only', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batter')).toBe(false);
    expect(await verifyPassword('not a hash', 'correct horse battery')).toBe(false);
  });

  it('salts: two hashes of one password differ, both verify', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password'),
      hashPassword('same password'),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(b, 'same password')).toBe(true);
  });

  it('refuses a short password and a huge one, says why, accepts anything else', () => {
    expect(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toContain(
      `${PASSWORD_MIN_LENGTH} characters`,
    );
    expect(passwordProblem('é'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordProblem('x'.repeat(PASSWORD_MAX_BYTES + 1))).toContain(
      `${PASSWORD_MAX_BYTES} bytes`,
    );
    expect(passwordProblem('        spaces      ')).toBeNull();
  });

  it('keeps one decoy hash per process', async () => {
    expect(await decoyHash()).toBe(await decoyHash());
  });
});
