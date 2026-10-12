/**
 * Short-lived cache behind an interface.
 *
 * Used by the door to keep a verified mission context for a few seconds so
 * the slow hash runs once per token, not once per call. The interface is the
 * contract; `MemoryCacheClient` is the single-process implementation of ADR
 * pivot-v4-to-v5 D1 ("cache and rate limit in memory, single process").
 *
 * // single-process only — a multi-replica deployment replaces
 * // `MemoryCacheClient` with a shared implementation of `CacheClient`
 * // (Redis-compatible store); nothing else changes.
 */

export interface CacheClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface MemoryEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  /** Upper bound on live entries. When reached, the oldest entry (by
   *  insertion or last `set`) is evicted. Default 10 000. */
  maxEntries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Bounded in-memory cache. `Map` keeps insertion order, so re-setting a key
 * moves it to the end and the first key is always the oldest. Expired entries
 * are dropped lazily on read and swept when the bound is hit.
 */
export class MemoryCacheClient implements CacheClient {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    if (options.maxEntries !== undefined && options.maxEntries < 1) {
      throw new Error('MemoryCacheClient: maxEntries must be >= 1');
    }
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Live entry count (expired entries not yet swept are counted). */
  get size(): number {
    return this.store.size;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    // Delete first so the key moves to the end of the insertion order.
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      this.sweepExpired();
      while (this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next();
        if (oldest.done) break;
        this.store.delete(oldest.value);
      }
    }
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  private sweepExpired(): void {
    const t = this.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= t) this.store.delete(key);
    }
  }
}
