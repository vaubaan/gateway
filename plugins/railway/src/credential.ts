/**
 * Credential of the `railway` provider — OAuth2 authorization code + PKCE,
 * refreshed on the hot path.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md (audience binding, refresh) ;
 *        docs/decisions/plugin-contract-and-credential-spec.md D2.
 *
 * The host runs the authorization-code dance from `railwayCredentialSpec` :
 * the company's Railway Auth app (`client_id` / `client_secret` in the
 * instance configuration), scopes `openid offline_access workspace:member`,
 * PKCE S256, `prompt=consent` so a refresh token is issued, and the RFC 8707
 * resource indicator `https://mcp.railway.com` on both the authorization and
 * the token request — without it the MCP server refuses the token.
 *
 * Railway access tokens live one hour. `railwayNeedsRefresh` tells the host
 * when a stored token is within the refresh window ; `refreshRailwayCredential`
 * exchanges the refresh token for a new pair (Basic client auth, same
 * resource indicator) and returns a new secret — it never mutates its input
 * and never persists anything : persistence is the host's job.
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type OAuth2CredentialSpec,
  type OAuth2Secret,
} from '@vaubaan/plugin-sdk';

export const RAILWAY_AUTHORIZATION_URL = 'https://backboard.railway.com/oauth/auth';
export const RAILWAY_TOKEN_URL = 'https://backboard.railway.com/oauth/token';
/** RFC 8707 resource indicator binding the token to the MCP audience. */
export const RAILWAY_MCP_RESOURCE = 'https://mcp.railway.com';
export const RAILWAY_SCOPES: readonly string[] = ['openid', 'offline_access', 'workspace:member'];
/** Refresh when the access token is within this window of expiry. */
export const RAILWAY_REFRESH_THRESHOLD_MS = 60_000;

/** Keys of `ProviderAppConfig` the refresh reads. The host collects both for every oauth2 plugin. */
export const RAILWAY_APP_CONFIG_KEYS = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
} as const;

export const railwayCredentialSpec: OAuth2CredentialSpec = {
  kind: 'oauth2',
  authorizationUrl: RAILWAY_AUTHORIZATION_URL,
  tokenUrl: RAILWAY_TOKEN_URL,
  scopes: RAILWAY_SCOPES,
  pkce: true,
  resourceIndicator: RAILWAY_MCP_RESOURCE,
  clientAuthMethod: 'client_secret_basic',
  refreshable: true,
  extraAuthorizationParams: { prompt: 'consent' },
};

/**
 * True when the stored access token expires within `thresholdMs` (or has
 * already expired). A secret without `expiresAt` is never considered stale :
 * the host relies on `UpstreamAuthError` for it.
 */
export function railwayNeedsRefresh(
  secret: OAuth2Secret,
  now: number = Date.now(),
  thresholdMs: number = RAILWAY_REFRESH_THRESHOLD_MS,
): boolean {
  if (secret.expiresAt === null) return false;
  const expiresAt = Date.parse(secret.expiresAt);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - now < thresholdMs;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
}

/**
 * Exchange the refresh token for a fresh access token. Throws
 * `UpstreamAuthError` when Railway rejects the grant (the host then marks
 * the connection `expired`), a plain `Error` naming the missing key when
 * the company's app is not configured.
 */
export async function refreshRailwayCredential(
  ctx: ConnectionContext,
  now: () => number = Date.now,
): Promise<OAuth2Secret> {
  const secret = expectCredentialKind('railway', ctx.credential, 'oauth2');
  if (!secret.refreshToken) {
    throw new UpstreamAuthError(
      'railway: the connection holds no refresh token — reconnect the provider',
      401,
    );
  }
  const clientId = requireAppConfig(ctx, RAILWAY_APP_CONFIG_KEYS.clientId);
  const clientSecret = requireAppConfig(ctx, RAILWAY_APP_CONFIG_KEYS.clientSecret);

  const res = await ctx.fetch(RAILWAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: secret.refreshToken,
      resource: RAILWAY_MCP_RESOURCE,
    }).toString(),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(
      `railway refused the refresh token (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`,
      res.status,
    );
  }
  if (!res.ok) throw new Error(`railway token endpoint failed with HTTP ${res.status}`);

  const json = (await res.json()) as TokenResponse;
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('railway token endpoint answered without an access_token');
  }
  return {
    kind: 'oauth2',
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : secret.refreshToken,
    expiresAt:
      typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
        ? new Date(now() + json.expires_in * 1000).toISOString()
        : null,
    scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : secret.scopes,
    metadata: secret.metadata,
  };
}

function requireAppConfig(ctx: ConnectionContext, key: string): string {
  const value = ctx.appConfig[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `railway: appConfig.${key} is missing — register the company's Railway Auth app in the instance configuration`,
    );
  }
  return value;
}
