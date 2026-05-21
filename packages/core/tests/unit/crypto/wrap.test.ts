import { describe, it, expect } from 'vitest';

import { generateUserKeypair } from '../../../src/crypto/keypair.js';
import { getSodium } from '../../../src/crypto/sodium.js';
import { unwrapPrivateKey, wrapPrivateKey } from '../../../src/crypto/wrap.js';

async function randomKek(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(32);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('wrap/unwrap private key', () => {
  it('round-trips: unwrap(wrap(sk, kek), kek) === sk', async () => {
    const kp = await generateUserKeypair();
    const kek = await randomKek();
    const wrapped = await wrapPrivateKey(kp.privateKey, kek);
    const out = await unwrapPrivateKey(wrapped, kek);
    expect(out).not.toBeNull();
    expect(bytesEqual(out as Uint8Array, kp.privateKey)).toBe(true);
  });

  it('returns null when the KEK is wrong', async () => {
    const kp = await generateUserKeypair();
    const kek = await randomKek();
    const wrong = await randomKek();
    const wrapped = await wrapPrivateKey(kp.privateKey, kek);
    const out = await unwrapPrivateKey(wrapped, wrong);
    expect(out).toBeNull();
  });

  it('returns null when the ciphertext is tampered (byte flip)', async () => {
    const kp = await generateUserKeypair();
    const kek = await randomKek();
    const wrapped = await wrapPrivateKey(kp.privateKey, kek);
    const tampered = new Uint8Array(wrapped);
    // Flip a byte inside the ciphertext (skip past the 24-byte nonce).
    tampered[30] = tampered[30] === undefined ? 0 : tampered[30] ^ 0x01;
    const out = await unwrapPrivateKey(tampered, kek);
    expect(out).toBeNull();
  });
});
