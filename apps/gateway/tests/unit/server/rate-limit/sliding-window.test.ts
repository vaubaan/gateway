/**
 * In-memory sliding window (spec §3.2 "actions per short sliding window", §6 "surface
 * rate limits"); both faces: the budget's synchronous `peek`/`push` and the composition
 * root's `RateLimiter.take`.
 */
import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '../../../../src/server/compose/ports.ts';
import {
  rateWindowKey,
  SlidingWindowRateLimiter,
} from '../../../../src/server/rate-limit/index.ts';

const T0 = Date.parse('2026-10-13T09:00:00.000Z');
const WINDOW = 60_000;

describe('SlidingWindowRateLimiter — peek / push', () => {
  it('an unknown key is an empty window', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.peek('k', WINDOW, T0)).toEqual({ count: 0, retryAfterMs: 0 });
  });

  it('peek never records; push records; retryAfterMs is when the oldest action leaves', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.peek('k', WINDOW, T0);
    limiter.peek('k', WINDOW, T0);
    expect(limiter.peek('k', WINDOW, T0).count).toBe(0);
    limiter.push('k', WINDOW, T0);
    limiter.push('k', WINDOW, T0 + 10_000);
    expect(limiter.peek('k', WINDOW, T0 + 20_000)).toEqual({ count: 2, retryAfterMs: 40_000 });
  });

  it('slides: actions older than the window drop out one by one, not all at once', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.push('k', WINDOW, T0);
    limiter.push('k', WINDOW, T0 + 30_000);
    expect(limiter.peek('k', WINDOW, T0 + 59_999).count).toBe(2);
    expect(limiter.peek('k', WINDOW, T0 + 60_000)).toEqual({ count: 1, retryAfterMs: 30_000 });
    expect(limiter.peek('k', WINDOW, T0 + 90_000)).toEqual({ count: 0, retryAfterMs: 0 });
    expect(limiter.size).toBe(0);
  });

  it('keeps an action recorded after a later one in its place', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.push('k', WINDOW, T0 + 30_000);
    limiter.push('k', WINDOW, T0); // timed before the first, recorded after it
    // The oldest is T0: it leaves first, and the probe counts from it.
    expect(limiter.peek('k', WINDOW, T0 + 40_000)).toEqual({ count: 2, retryAfterMs: 20_000 });
    expect(limiter.peek('k', WINDOW, T0 + 60_000)).toEqual({ count: 1, retryAfterMs: 30_000 });
  });

  it('keys are independent', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.push('a', WINDOW, T0);
    expect(limiter.peek('b', WINDOW, T0).count).toBe(0);
    expect(limiter.peek('a', WINDOW, T0).count).toBe(1);
  });

  it('refuses a non-positive window', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(() => limiter.peek('k', 0, T0)).toThrow(RangeError);
    expect(() => limiter.push('k', -1, T0)).toThrow(RangeError);
  });

  it('sweeps idle keys once above the prune threshold', () => {
    const limiter = new SlidingWindowRateLimiter({ pruneThreshold: 3 });
    for (let i = 0; i < 3; i++) limiter.push(`k${i}`, WINDOW, T0);
    expect(limiter.size).toBe(3);
    limiter.push('fresh', WINDOW, T0 + WINDOW + 1); // size 4 > threshold: the three idle keys go
    expect(limiter.size).toBe(1);
    expect(limiter.peek('fresh', WINDOW, T0 + WINDOW + 1).count).toBe(1);
  });
});

describe('SlidingWindowRateLimiter — RateLimiter port (take)', () => {
  it('implements the composition root port: check and consume in one call', async () => {
    let now = T0;
    const limiter: RateLimiter = new SlidingWindowRateLimiter({ now: () => now });
    expect(await limiter.take('ip', 2, WINDOW)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    now += 1000;
    expect(await limiter.take('ip', 2, WINDOW)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    now += 1000;
    expect(await limiter.take('ip', 2, WINDOW)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: WINDOW - 2000,
    });
    now = T0 + WINDOW; // the first action leaves the window: one credit back
    expect(await limiter.take('ip', 2, WINDOW)).toMatchObject({ allowed: true, remaining: 0 });
  });
});

describe('rateWindowKey', () => {
  it('keys a window by mission, resource set and risk', () => {
    expect(rateWindowKey('mis_1', 'set_1', 'github.code-read')).toBe(
      'mission:mis_1:set:set_1:risk:github.code-read',
    );
    expect(rateWindowKey('mis_1', 's', 'a')).not.toBe(rateWindowKey('mis_2', 's', 'a'));
    expect(rateWindowKey('mis_1', 's', 'a')).not.toBe(rateWindowKey('mis_1', 's', 'b'));
    // Each resource set keeps its own rate limit (risk model §4.7).
    expect(rateWindowKey('mis_1', 's1', 'a')).not.toBe(rateWindowKey('mis_1', 's2', 'a'));
  });
});
