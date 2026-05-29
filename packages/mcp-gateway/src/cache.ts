/**
 * AccessTokenContext cache.
 *
 * Two implementations:
 *   - MemoryCacheClient   : Map<string, {value, expiresAt}>. Default for dev/test.
 *   - RedisCacheClient    : Upstash REST. Production hot-path.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.3.
 * ADR  : docs/decisions/redis-cache-upstash-with-memory-fallback.md.
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

export class MemoryCacheClient implements CacheClient {
  private readonly store = new Map<string, MemoryEntry>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export interface UpstashConfig {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class RedisCacheClient implements CacheClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: UpstashConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
    this.fetchFn = config.fetchImpl ?? fetch;
  }

  private async cmd(parts: string[]): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
    });
    if (!res.ok) throw new Error(`Upstash command failed: ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const r = await this.cmd(['GET', key]);
    if (r === null || r === undefined) return null;
    try {
      return JSON.parse(r as string) as T;
    } catch {
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.cmd(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
  }

  async del(key: string): Promise<void> {
    await this.cmd(['DEL', key]);
  }
}

/**
 * Build the right cache client from environment.
 *
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → RedisCacheClient.
 *   - otherwise → MemoryCacheClient (per-process, fine for dev/test/fallback).
 */
export function buildCacheClient(env: NodeJS.ProcessEnv = process.env): CacheClient {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return new RedisCacheClient({ url, token });
  }
  return new MemoryCacheClient();
}
