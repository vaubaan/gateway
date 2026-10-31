import sodium from 'libsodium-wrappers-sumo';
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

  it('verifies the hashes stored before: libsodium crypto_pwhash_str, interactive limits', async () => {
    await sodium.ready;
    const stored = sodium.crypto_pwhash_str(
      'a sentence ada remembers',
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    );
    expect(await verifyPassword(stored, 'a sentence ada remembers')).toBe(true);
    expect(await verifyPassword(stored, 'a sentence ada forgot')).toBe(false);
  });

  it('writes the limits and format libsodium wrote, which libsodium still verifies', async () => {
    await sodium.ready;
    const hash = await hashPassword('a sentence ada remembers');
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(sodium.crypto_pwhash_str_verify(hash, 'a sentence ada remembers')).toBe(true);
  });

  it('hashes off the event loop: timers keep firing while a hash is computed', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await hashPassword('a sentence ada remembers');
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
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
