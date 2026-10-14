/**
 * Per-call installation token, served from the host's connection-scoped
 * cache when one is provided.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the token is minted inside the
 *        gateway, used for the call, and never returned to the executor.
 *
 * Minting costs one signed JWT and one round trip to GitHub per call. An
 * installation token lives one hour, so the host hands `execute` a cache
 * scoped to the connection (`ExecuteContext.credentialCache`) and the plugin
 * keeps one token per repository scope for `INSTALLATION_TOKEN_CACHE_SECONDS`.
 * The host drops the entries when GitHub rejects a call or the connection
 * stops being `active` ; without a cache every call mints.
 *
 * `github__mint_install_token` does NOT go through here : its result leaves
 * the gateway, so it is always a fresh token of its own.
 */

import type { ExecuteContext } from '@vaubaan/plugin-sdk';

import { installationTokenFor } from './credential.ts';

/** How long a per-call token is reused (GitHub's own lifetime is 60 minutes). */
export const INSTALLATION_TOKEN_CACHE_SECONDS = 50 * 60;
/** A cached token this close to its expiry is not served. */
export const INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS = 5 * 60;

const MS_PER_SECOND = 1000;
/** Cache key of the installation-wide token (account-shaped tools). */
const ALL_REPOSITORIES = '*';

interface CachedToken {
  readonly token: string;
  /** ISO-8601 expiry announced by GitHub. */
  readonly expiresAt: string;
  /** What the installation holds, as GitHub answered; absent in an entry cached by an older build. */
  readonly permissions?: Readonly<Record<string, string>>;
}

/** The token of one call and the permissions the installation holds (empty when GitHub did not say). */
export interface CallGrant {
  readonly token: string;
  readonly permissions: Readonly<Record<string, string>>;
}

export function installationTokenCacheKey(repo: string | undefined): string {
  return `installation-token:${repo ?? ALL_REPOSITORIES}`;
}

function secondsLeft(expiresAt: string, nowMs: number): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return 0;
  return Math.floor((expiry - nowMs) / MS_PER_SECOND) - INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS;
}

/**
 * The installation token of one call : scoped to `repo` (name without owner)
 * when the call names one, installation-wide otherwise.
 */
export async function installationTokenForCall(
  ctx: ExecuteContext,
  repo: string | undefined,
  now: () => number = Date.now,
): Promise<string> {
  return (await installationGrantForCall(ctx, repo, now)).token;
}

/** `installationTokenForCall`, with the permissions the installation holds. */
export async function installationGrantForCall(
  ctx: ExecuteContext,
  repo: string | undefined,
  now: () => number = Date.now,
): Promise<CallGrant> {
  const cache = ctx.credentialCache;
  const key = installationTokenCacheKey(repo);
  if (cache) {
    const cached = await cache.get<CachedToken>(key);
    if (cached && secondsLeft(cached.expiresAt, now()) > 0) {
      return { token: cached.token, permissions: cached.permissions ?? {} };
    }
  }
  const minted = await installationTokenFor(ctx, repo ? { repositories: [repo] } : {});
  if (cache) {
    const expiresAt = minted.expiresAt.toISOString();
    const ttl = Math.min(INSTALLATION_TOKEN_CACHE_SECONDS, secondsLeft(expiresAt, now()));
    if (ttl > 0) {
      await cache.set<CachedToken>(
        key,
        { token: minted.token, expiresAt, permissions: minted.permissions },
        ttl,
      );
    }
  }
  return { token: minted.token, permissions: minted.permissions };
}
