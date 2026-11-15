/**
 * Upstream credential cache — the host side of
 * `ExecuteContext.credentialCache` (`@vaubaan/plugin-sdk`).
 *
 * Some plugins derive a short-lived upstream credential on every call (GitHub
 * mints an installation token from the company's App key: one signed JWT and
 * one round trip). The host hands `execute` a cache scoped to the account
 * so the plugin can reuse that credential for a few minutes; the plugin picks
 * the key inside its account and the lifetime.
 *
 * Keys are namespaced `upstream-credential:<account id>:<updated_at>:<key>`:
 * a reconnect, a refresh or a revocation rewrites the account row, so the
 * entries written before it are unreachable from then on, whatever the cache
 * behind `CacheClient`. `drop(accountId)` also deletes the entries this
 * process wrote, which the upstream stage calls as soon as the service
 * rejects a call or the account stops being `active`.
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

import type { AccountRecord } from '../store/types';

const KEY_PREFIX = 'upstream-credential';
/** An upstream credential is never kept longer than this, whatever the plugin asks. */
export const MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS = 55 * 60;

export class AccountCredentialCache {
  // single-process only — see the module comment.
  private readonly written = new Map<string, Set<string>>();

  constructor(private readonly cache: CacheClient) {}

  /** The cache one `execute` call receives for `account`. */
  scopeFor(account: Pick<AccountRecord, 'id' | 'updatedAt'>): UpstreamCredentialCache {
    const namespace = `${KEY_PREFIX}:${account.id}:${account.updatedAt}:`;
    return {
      get: <T>(key: string) => this.cache.get<T>(namespace + key),
      set: async <T>(key: string, value: T, ttlSeconds: number) => {
        const ttl = Math.min(Math.floor(ttlSeconds), MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS);
        if (!(ttl > 0)) return;
        await this.cache.set(namespace + key, value, ttl);
        let keys = this.written.get(account.id);
        if (!keys) this.written.set(account.id, (keys = new Set()));
        keys.add(namespace + key);
      },
    };
  }

  /** Deletes every entry this process wrote for the account; returns how many. */
  async drop(accountId: string): Promise<number> {
    const keys = this.written.get(accountId);
    if (!keys) return 0;
    this.written.delete(accountId);
    await Promise.all([...keys].map((key) => this.cache.del(key)));
    return keys.size;
  }
}
