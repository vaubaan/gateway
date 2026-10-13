/**
 * In-memory implementations of the root's ports.
 *
 * Every class here is `// single-process only`: its state lives in the Node
 * process and is neither shared between replicas nor kept across restarts
 * (acceptable per ADR D1 for rate-limit windows and caches). The comment on
 * each class names the interface a hosted deployment implements instead.
 */
import { MemoryCacheClient } from '@vaubaan/gateway-core';

import type { RateLimitDecision, RateLimiter, SessionStore } from './ports';

export type Clock = () => number;
const wallClock: Clock = () => Date.now();

/** Above this many live windows, expired ones are swept on every `take`. */
const RATE_LIMIT_PRUNE_THRESHOLD = 10_000;
/** Bound on concurrently remembered web sessions. */
const SESSION_STORE_MAX_ENTRIES = 50_000;
const MS_PER_SECOND = 1000;

// single-process only — hosted replacement: a Redis `RateLimiter` (INCR + PEXPIRE).
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly now: Clock = wallClock) {}

  async take(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      this.windows.set(key, w);
    }
    if (w.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, w.resetAt - t) };
    }
    w.count += 1;
    if (this.windows.size > RATE_LIMIT_PRUNE_THRESHOLD) this.prune(t);
    return { allowed: true, remaining: limit - w.count, retryAfterMs: 0 };
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}

// single-process only — hosted replacement: a store-backed or Redis `SessionStore`.
// Built on gateway-core's bounded `MemoryCacheClient` (the single cache
// implementation); the session port keeps its millisecond TTL.
export class MemorySessionStore<T = unknown> implements SessionStore<T> {
  private readonly cache: MemoryCacheClient;
  constructor(now: Clock = wallClock) {
    this.cache = new MemoryCacheClient({ maxEntries: SESSION_STORE_MAX_ENTRIES, now });
  }
  async get(id: string): Promise<T | null> {
    return this.cache.get<T>(id);
  }
  async set(id: string, value: T, ttlMs: number): Promise<void> {
    await this.cache.set(id, value, ttlMs / MS_PER_SECOND);
  }
  async delete(id: string): Promise<void> {
    await this.cache.del(id);
  }
}
