/**
 * Sliding-window rate limiter — in memory, single process.
 *
 * Spec §3.2 ("rate limit: number of actions per short sliding window"), §6 ("surface
 * rate limits on the MCP endpoint per mission, on connect flows per user, on the
 * request page per IP"). ADR atomic-budget-accounting: windows live in memory; a
 * restart forgives a few seconds of rate, never a quota (pivot ADR D1).
 *
 * Two faces on one state:
 *
 * - `SlidingWindows` (synchronous `peek` / `push`) is what the budget decision uses
 *   inside the store's transaction: it must probe without consuming (a call refused
 *   on another risk records nothing) and record only once the call is allowed.
 * - `RateLimiter` (`take`, the composition root's port) is the surface
 *   limiter: one call checks and consumes.
 *
 * Each key holds the timestamps of its actions, pruned to the window on every access.
 *
 * // single-process only — hosted replacement: a Redis implementation keeps one sorted
 * set per key scored by timestamp (`ZREMRANGEBYSCORE key -inf now-window`, `ZCARD`,
 * `ZADD key now member`, `PEXPIRE key window`) in one Lua script or `MULTI` so the
 * probe and the record stay atomic; the budget would then probe before its SQLite
 * transaction and record after commit, accepting a window-wide race the quota does
 * not have (the quota stays authoritative in the store).
 */

import type { RateLimitDecision, RateLimiter } from '../compose/ports.ts';

/** What a window looks like at an instant, without touching it. */
export interface WindowProbe {
  /** Actions recorded inside the window ending now. */
  readonly count: number;
  /** Milliseconds until the oldest recorded action leaves the window; 0 when empty. */
  readonly retryAfterMs: number;
}

export interface SlidingWindows {
  /** The window of `key` at `nowMs`, without recording anything. */
  peek(key: string, windowMs: number, nowMs: number): WindowProbe;
  /** Records one action of `key` at `nowMs`; `windowMs` bounds how long the key lives. */
  push(key: string, windowMs: number, nowMs: number): void;
}

export type MillisClock = () => number;

export interface SlidingWindowOptions {
  readonly now?: MillisClock;
  /** Above this many live keys, keys whose last action is older than their last window
   *  are dropped on push (`peek` never sweeps). */
  readonly pruneThreshold?: number;
}

const DEFAULT_PRUNE_THRESHOLD = 10_000;

interface Window {
  /** Ascending timestamps of the actions still inside the last window probed. */
  hits: number[];
  /** Window length last used with this key; bounds how long an idle key lives. */
  windowMs: number;
}

function assertWindow(windowMs: number): void {
  if (!(windowMs > 0)) throw new RangeError(`rate window must be positive (got ${windowMs} ms)`);
}

/** Drops the actions that left the window `(nowMs - windowMs, nowMs]`. */
function prune(window: Window, nowMs: number): void {
  const cutoff = nowMs - window.windowMs;
  let keep = 0;
  while (keep < window.hits.length && (window.hits[keep] as number) <= cutoff) keep++;
  if (keep > 0) window.hits.splice(0, keep);
}

// single-process only — replaced, in a hosted deployment, by a Redis implementation of the
// same two interfaces, `SlidingWindows` and `RateLimiter` (see the module comment).
export class SlidingWindowRateLimiter implements SlidingWindows, RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: MillisClock;
  private readonly pruneThreshold: number;

  constructor(options: SlidingWindowOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.pruneThreshold = options.pruneThreshold ?? DEFAULT_PRUNE_THRESHOLD;
  }

  /** Number of keys currently remembered (diagnostics and tests). */
  get size(): number {
    return this.windows.size;
  }

  peek(key: string, windowMs: number, nowMs: number): WindowProbe {
    assertWindow(windowMs);
    const window = this.windows.get(key);
    if (!window) return { count: 0, retryAfterMs: 0 };
    window.windowMs = windowMs;
    prune(window, nowMs);
    const oldest = window.hits[0];
    if (oldest === undefined) {
      this.windows.delete(key);
      return { count: 0, retryAfterMs: 0 };
    }
    return { count: window.hits.length, retryAfterMs: oldest + windowMs - nowMs };
  }

  push(key: string, windowMs: number, nowMs: number): void {
    assertWindow(windowMs);
    const window = this.windows.get(key);
    if (window) {
      window.windowMs = windowMs;
      window.hits.push(nowMs);
    } else {
      this.windows.set(key, { hits: [nowMs], windowMs });
    }
    if (this.windows.size > this.pruneThreshold) this.sweep(nowMs);
  }

  async take(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const t = this.now();
    const probe = this.peek(key, windowMs, t);
    if (probe.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: probe.retryAfterMs };
    }
    this.push(key, windowMs, t);
    return { allowed: true, remaining: limit - probe.count - 1, retryAfterMs: 0 };
  }

  /** Forgets every key whose newest action already left its window. */
  private sweep(nowMs: number): void {
    for (const [key, window] of this.windows) {
      const newest = window.hits[window.hits.length - 1];
      if (newest === undefined || newest + window.windowMs <= nowMs) this.windows.delete(key);
    }
  }
}

/**
 * The window key of one line of one mission: a risk in one resource set (spec §3.2:
 * one budget per mission; risk model §4.7: each set keeps its own).
 */
export function rateWindowKey(missionId: string, resourceSetId: string, riskId: string): string {
  return `mission:${missionId}:set:${resourceSetId}:risk:${riskId}`;
}
