import { describe, expect, it, beforeEach } from 'vitest';

import { identityStore, type Identity } from '../../../src/lib/crypto/identity-store';

function makeIdentity(seed: number): Identity {
  const publicKey = new Uint8Array(32);
  const privateKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    publicKey[i] = (seed + i) & 0xff;
    privateKey[i] = (seed + 0x80 + i) & 0xff;
  }
  return { publicKey, privateKey, fingerprint: `fp-${String(seed)}` };
}

describe('identityStore', () => {
  beforeEach(() => {
    identityStore.clear();
  });

  it('returns null before any set()', () => {
    expect(identityStore.get()).toBeNull();
  });

  it('round-trips an identity through set() / get()', () => {
    const id = makeIdentity(1);
    identityStore.set(id);
    const out = identityStore.get();
    expect(out).not.toBeNull();
    expect(out?.fingerprint).toBe('fp-1');
    expect(out?.publicKey).toBe(id.publicKey);
    expect(out?.privateKey).toBe(id.privateKey);
  });

  it('clear() wipes the private and public key bytes before dropping', () => {
    const id = makeIdentity(2);
    identityStore.set(id);
    identityStore.clear();
    expect(identityStore.get()).toBeNull();
    // The Uint8Array we set is mutated in place — every byte is now 0.
    expect(id.privateKey.every((b) => b === 0)).toBe(true);
    expect(id.publicKey.every((b) => b === 0)).toBe(true);
  });

  it('is a singleton — re-importing yields the same instance', async () => {
    const id = makeIdentity(3);
    identityStore.set(id);
    const mod = await import('../../../src/lib/crypto/identity-store');
    expect(mod.identityStore).toBe(identityStore);
    expect(mod.identityStore.get()?.fingerprint).toBe('fp-3');
  });
});
