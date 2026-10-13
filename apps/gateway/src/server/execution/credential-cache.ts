/**
 * Upstream credential cache — the host side of
 * `ExecuteContext.credentialCache` (`@vaubaan/plugin-sdk`).
 *
 * Some plugins derive a short-lived upstream credential on every call (GitHub
 * mints an installation token from the company's App key: one signed JWT and
 * one round trip). The host hands `execute` a cache scoped to the connection
 * so the plugin can reuse that credential for a few minutes; the plugin picks
 * the key inside its connection and the lifetime.
 *
 * Keys are namespaced `upstream-credential:<connection id>:<updated_at>:<key>`:
 * a reconnect, a refresh or a revocation rewrites the connection row, so the
 * entries written before it are unreachable from then on, whatever the cache
 * behind `CacheClient`. `drop(connectionId)` also deletes the entries this
 * process wrote, which the upstream stage calls as soon as the provider
 * rejects a call or the connection stops being `active`.
 *
 * The values are live upstream credentials, in memory only (spec §2.4: the
 * gateway "mints or decrypts in memory an ephemeral upstream credential").
 * // single-process only — the key index below lives in this process, and the
 * default `MemoryCacheClient` keeps the values in this process's memory. A
 * hosted deployment either keeps this cache per replica (correct as is: the
 * namespace makes stale entries unreachable) or plugs a shared `CacheClient`
 * that encrypts its values; it must never write these tokens in clear to a
 * shared store.
 */
import type { CacheClient } from '@vaubaan/gateway-core';
import type { UpstreamCredentialCache } from '@vaubaan/plugin-sdk';

import type { ConnectionRecord } from '../store/types';

const KEY_PREFIX = 'upstream-credential';
/** An upstream credential is never kept longer than this, whatever the plugin asks. */
export const MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS = 55 * 60;

export class ConnectionCredentialCache {
  // single-process only — see the module comment.
  private readonly written = new Map<string, Set<string>>();

  constructor(private readonly cache: CacheClient) {}

  /** The cache one `execute` call receives for `connection`. */
  scopeFor(connection: Pick<ConnectionRecord, 'id' | 'updatedAt'>): UpstreamCredentialCache {
    const namespace = `${KEY_PREFIX}:${connection.id}:${connection.updatedAt}:`;
    return {
      get: <T>(key: string) => this.cache.get<T>(namespace + key),
      set: async <T>(key: string, value: T, ttlSeconds: number) => {
        const ttl = Math.min(Math.floor(ttlSeconds), MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS);
        if (!(ttl > 0)) return;
        await this.cache.set(namespace + key, value, ttl);
        let keys = this.written.get(connection.id);
        if (!keys) this.written.set(connection.id, (keys = new Set()));
        keys.add(namespace + key);
      },
    };
  }

  /** Deletes every entry this process wrote for the connection; returns how many. */
  async drop(connectionId: string): Promise<number> {
    const keys = this.written.get(connectionId);
    if (!keys) return 0;
    this.written.delete(connectionId);
    await Promise.all([...keys].map((key) => this.cache.del(key)));
    return keys.size;
  }
}
