/**
 * In-memory implementations of the root's ports.
 *
 * Every class here is `// single-process only`: its state lives in the Node
 * process and is neither shared between replicas nor kept across restarts
 * (acceptable per ADR D1 for rate-limit windows and caches). The comment on
 * each class names the interface a hosted deployment implements instead.
 */
import type {
  CacheClient,
  PluginRegistry,
  PluginSummary,
  RateLimitDecision,
  RateLimiter,
  SessionStore,
  Store,
} from './ports';

export type Clock = () => number;
const wallClock: Clock = () => Date.now();

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
    if (this.windows.size > 10_000) this.prune(t);
    return { allowed: true, remaining: limit - w.count, retryAfterMs: 0 };
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}

// single-process only — hosted replacement: a Redis `CacheClient` (SET PX / GET / DEL).
export class MemoryCache implements CacheClient {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(
    private readonly maxEntries = 5_000,
    private readonly now: Clock = wallClock,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Bounded: evict the oldest insertion (Map preserves insertion order).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

// single-process only — hosted replacement: a store-backed or Redis `SessionStore`.
export class MemorySessionStore<T = unknown> implements SessionStore<T> {
  private readonly cache: MemoryCache;
  constructor(now: Clock = wallClock) {
    this.cache = new MemoryCache(50_000, now);
  }
  async get(id: string): Promise<T | null> {
    return (await this.cache.get<T>(id)) ?? null;
  }
  async set(id: string, value: T, ttlMs: number): Promise<void> {
    await this.cache.set(id, value, ttlMs);
  }
  async delete(id: string): Promise<void> {
    await this.cache.delete(id);
  }
}

// single-process only — placeholder until the SQLite `Store` (P0.3) is wired by the root.
export class NullStore implements Store {
  readonly kind = 'none';
  async ping(): Promise<void> {
    return undefined;
  }
  async close(): Promise<void> {
    return undefined;
  }
}

// Placeholder until `@vaubaan/plugin-sdk`'s registry (P0.2) is wired by the root.
export class EmptyPluginRegistry implements PluginRegistry {
  list(): readonly PluginSummary[] {
    return [];
  }
  has(_id: string): boolean {
    return false;
  }
}
