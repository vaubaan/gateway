import { describe, expect, it } from 'vitest';
import { AttestRateLimit } from '../../src/rate-limit.ts';

describe('attestation rate limit', () => {
  it('lets a burst through per address, then refills', () => {
    let now = 0;
    const limit = new AttestRateLimit({
      now: () => now,
      perAddress: { burst: 2, perSecond: 1 },
      global: { burst: 100, perSecond: 100 },
    });
    expect([limit.allow('a'), limit.allow('a'), limit.allow('a')]).toEqual([true, true, false]);
    expect(limit.allow('b')).toBe(true); // another address has its own bucket
    now = 1000;
    expect(limit.allow('a')).toBe(true);
    expect(limit.allow('a')).toBe(false);
  });

  it('caps all addresses together under the platform quota', () => {
    const limit = new AttestRateLimit({
      now: () => 0,
      perAddress: { burst: 10, perSecond: 1 },
      global: { burst: 3, perSecond: 1 },
    });
    expect(['a', 'b', 'c', 'd'].map((address) => limit.allow(address))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('forgets the oldest address beyond its memory', () => {
    const limit = new AttestRateLimit({
      now: () => 0,
      perAddress: { burst: 1, perSecond: 0 },
      maxAddresses: 1,
    });
    expect(limit.allow('a')).toBe(true);
    expect(limit.allow('a')).toBe(false);
    expect(limit.allow('b')).toBe(true); // 'a' forgotten
    expect(limit.allow('a')).toBe(true);
  });

  it('forgets the least recently seen address, not the first inserted', () => {
    const limit = new AttestRateLimit({
      now: () => 0,
      perAddress: { burst: 2, perSecond: 0 },
      maxAddresses: 2,
    });
    limit.allow('a');
    limit.allow('b');
    limit.allow('a'); // 'a' seen again: 'b' is now the least recent; 'a' has no token left
    limit.allow('c'); // forgets 'b'
    expect(limit.allow('a')).toBe(false); // remembered, still empty
    expect(limit.allow('b')).toBe(true); // forgotten, so a fresh bucket
  });
});
