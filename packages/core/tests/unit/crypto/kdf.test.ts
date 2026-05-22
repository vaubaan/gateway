import { describe, it, expect } from 'vitest';

import { deriveKEK } from '../../../src/crypto/kdf.js';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('deriveKEK (Argon2id)', () => {
  // Argon2id at m=64 MiB is slow on purpose; raise the per-test timeout
  // a bit so CI doesn't flake on cold runs.
  it('is deterministic for the same password+salt+params', async () => {
    const salt = new Uint8Array(16);
    salt.fill(0x42);
    const a = await deriveKEK('correct horse battery staple', salt);
    const b = await deriveKEK('correct horse battery staple', salt);
    expect(a.length).toBe(32);
    expect(bytesEqual(a, b)).toBe(true);
  }, 30_000);

  it('yields different KEKs for different salts', async () => {
    const salt1 = new Uint8Array(16).fill(0x01);
    const salt2 = new Uint8Array(16).fill(0x02);
    const a = await deriveKEK('hunter2', salt1);
    const b = await deriveKEK('hunter2', salt2);
    expect(bytesEqual(a, b)).toBe(false);
  }, 30_000);

  it('refuses params weaker than spec defaults (m=32 MiB)', async () => {
    const salt = new Uint8Array(16).fill(0x42);
    await expect(
      deriveKEK('pw', salt, { m: 33554432, t: 3, p: 1, alg: 'argon2id' }),
    ).rejects.toThrow(/too weak/i);
  });

  it('refuses a salt of the wrong length', async () => {
    const tooShort = new Uint8Array(8);
    await expect(deriveKEK('pw', tooShort)).rejects.toThrow(/16 bytes/);
  });
});
