/**
 * Bounded in-memory cache behind `CacheClient` (single-process only).
 */
import { describe, expect, test } from 'vitest';

import { MemoryCacheClient } from '../../src/cache.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('MemoryCacheClient', () => {
  test('get returns the value until the TTL elapses, then null', async () => {
    const c = clock();
    const cache = new MemoryCacheClient({ now: c.now });
    await cache.set('k', { a: 1 }, 10);
    expect(await cache.get('k')).toEqual({ a: 1 });
    c.advance(9_999);
    expect(await cache.get('k')).toEqual({ a: 1 });
    c.advance(1);
    expect(await cache.get('k')).toBeNull();
    expect(cache.size).toBe(0);
  });

  test('a TTL that is not a positive, finite number caches nothing', async () => {
    // `NaN` would make an entry that never expires (`NaN <= now` is false) :
    // the door caches verified mission contexts here.
    const cache = new MemoryCacheClient({ now: clock().now });
    for (const ttl of [NaN, Infinity, 0, -5]) {
      await cache.set('k', 'fresh', 10);
      await cache.set('k', 'stale-forever', ttl);
      expect(await cache.get('k')).toBeNull();
    }
    expect(cache.size).toBe(0);
  });

  test('del removes the key', async () => {
    const cache = new MemoryCacheClient();
    await cache.set('k', 1, 60);
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  test('the bound evicts the oldest entry first', async () => {
    const cache = new MemoryCacheClient({ maxEntries: 2 });
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.set('c', 3, 60);
    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('c')).toBe(3);
  });

  test('re-setting a key refreshes its age instead of growing the cache', async () => {
    const cache = new MemoryCacheClient({ maxEntries: 2 });
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.set('a', 10, 60); // a is now the newest
    await cache.set('c', 3, 60); // evicts b, the oldest
    expect(cache.size).toBe(2);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).toBe(10);
    expect(await cache.get('c')).toBe(3);
  });

  test('expired entries are swept before a live one is evicted', async () => {
    const c = clock();
    const cache = new MemoryCacheClient({ maxEntries: 2, now: c.now });
    await cache.set('short', 1, 1);
    await cache.set('long', 2, 60);
    c.advance(2_000);
    await cache.set('new', 3, 60);
    expect(await cache.get('long')).toBe(2);
    expect(await cache.get('new')).toBe(3);
    expect(await cache.get('short')).toBeNull();
  });

  test('maxEntries below 1 is rejected', () => {
    expect(() => new MemoryCacheClient({ maxEntries: 0 })).toThrow(/maxEntries/);
  });
});
