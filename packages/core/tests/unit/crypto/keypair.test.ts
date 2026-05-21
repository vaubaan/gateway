import { describe, it, expect } from 'vitest';

import { fingerprintOf, generateUserKeypair } from '../../../src/crypto/keypair.js';

describe('generateUserKeypair', () => {
  it('returns 32-byte public and private keys', async () => {
    const kp = await generateUserKeypair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('emits a 32-hex-char fingerprint matching sha256(pub)[..16]', async () => {
    const kp = await generateUserKeypair();
    expect(kp.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    const recomputed = await fingerprintOf(kp.publicKey);
    expect(recomputed).toBe(kp.fingerprint);
  });

  it('produces distinct fingerprints for distinct keypairs', async () => {
    const a = await generateUserKeypair();
    const b = await generateUserKeypair();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
