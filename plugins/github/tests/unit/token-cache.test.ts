/**
 * Per-call installation token and the host's connection-scoped cache
 * (`ExecuteContext.credentialCache`) : minted once per repository scope,
 * reused while it is far from expiry, never shared between scopes, and
 * never used by `github__mint_install_token`.
 */

import type { UpstreamCredentialCache } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { githubPlugin } from '../../src/index.ts';
import {
  INSTALLATION_TOKEN_CACHE_SECONDS,
  INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS,
  installationTokenCacheKey,
  installationTokenForCall,
} from '../../src/token-cache.ts';
import { MINT_URL, appRepo, executeCtx } from './fixtures.ts';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const HOUR_MS = 3_600_000;

function memoryCache() {
  const entries = new Map<string, { value: unknown; ttl: number }>();
  const cache: UpstreamCredentialCache = {
    get: async <T>(key: string) => (entries.get(key)?.value as T | undefined) ?? null,
    set: async (key, value, ttlSeconds) => {
      entries.set(key, { value, ttl: ttlSeconds });
    },
  };
  return { cache, entries };
}

const mint = (token: string, expiresInMs = HOUR_MS) => ({
  method: 'POST',
  url: MINT_URL,
  times: 1,
  body: { token, expires_at: new Date(NOW + expiresInMs).toISOString() },
});

describe('installationTokenForCall', () => {
  it('mints on every call when the host provides no cache', async () => {
    const fetch = mockFetch([mint('ghs_1'), mint('ghs_2')]);
    const ctx = executeCtx(fetch);
    expect(await installationTokenForCall(ctx, 'app', () => NOW)).toBe('ghs_1');
    expect(await installationTokenForCall(ctx, 'app', () => NOW)).toBe('ghs_2');
  });

  it('mints once per repository scope and serves the next calls from the cache', async () => {
    const fetch = mockFetch([mint('ghs_app'), mint('ghs_wide')]);
    const { cache, entries } = memoryCache();
    const ctx = executeCtx(fetch, [appRepo], { credentialCache: cache });

    expect(await installationTokenForCall(ctx, 'app', () => NOW)).toBe('ghs_app');
    expect(await installationTokenForCall(ctx, 'app', () => NOW + 60_000)).toBe('ghs_app');
    // The installation-wide token of account-shaped tools is another entry.
    expect(await installationTokenForCall(ctx, undefined, () => NOW)).toBe('ghs_wide');
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]?.json).toEqual({ repositories: ['app'] });
    expect([...entries.keys()].sort()).toEqual(
      [installationTokenCacheKey('app'), installationTokenCacheKey(undefined)].sort(),
    );
    expect(entries.get(installationTokenCacheKey('app'))?.ttl).toBe(
      INSTALLATION_TOKEN_CACHE_SECONDS,
    );
  });

  it('does not serve a token close to its expiry, and does not store one either', async () => {
    const margin = INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS * 1000;
    const fetch = mockFetch([mint('ghs_old'), mint('ghs_short', margin - 1000), mint('ghs_new')]);
    const { cache, entries } = memoryCache();
    const ctx = executeCtx(fetch, [appRepo], { credentialCache: cache });

    expect(await installationTokenForCall(ctx, 'app', () => NOW)).toBe('ghs_old');
    // 56 minutes later the cached token is inside the margin: mint again. The new one is
    // already too short-lived to be worth keeping.
    const later = NOW + HOUR_MS - margin + 1000;
    expect(await installationTokenForCall(ctx, 'app', () => later)).toBe('ghs_short');
    expect(entries.get(installationTokenCacheKey('app'))?.value).toMatchObject({
      token: 'ghs_old',
    });
    expect(await installationTokenForCall(ctx, 'app', () => later)).toBe('ghs_new');
  });

  it('bounds the lifetime by what is left of the token', async () => {
    const fetch = mockFetch([mint('ghs_20min', 20 * 60_000)]);
    const { cache, entries } = memoryCache();
    await installationTokenForCall(
      executeCtx(fetch, [appRepo], { credentialCache: cache }),
      'app',
      () => NOW,
    );
    expect(entries.get(installationTokenCacheKey('app'))?.ttl).toBe(
      20 * 60 - INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS,
    );
  });
});

describe('execute and the cache', () => {
  it('`github__mint_install_token` always mints a token of its own and caches nothing', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: MINT_URL,
        body: { token: 'ghs_handed_out', expires_at: new Date(NOW + HOUR_MS).toISOString() },
      },
    ]);
    const { cache, entries } = memoryCache();
    const ctx = executeCtx(fetch, [appRepo], { credentialCache: cache });
    await githubPlugin.execute(ctx, 'github__mint_install_token', { purpose: 'clone' });
    await githubPlugin.execute(ctx, 'github__mint_install_token', { purpose: 'clone' });
    expect(fetch.calls).toHaveLength(2);
    expect(entries.size).toBe(0);
  });
});
