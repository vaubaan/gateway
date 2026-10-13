/**
 * Credential of the `supabase` provider : OAuth 2.0 against the Management
 * API, through the OAuth app the company registered, with refresh.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §5 (plugins declare how
 *        to obtain and refresh a credential), §7.2.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md D2.
 *
 * The host runs the authorization-code dance from `supabaseCredential`
 * (authorize URL, PKCE, state, token exchange) — what the v4 web routes
 * `/api/integrations/supabase/{connect,callback}` did by hand. The plugin
 * only keeps what is specific to Supabase : the endpoints, the `all` scope
 * the Management API expects, and the refresh request. Access tokens live
 * one hour ; the refresh token rotates on every refresh.
 *
 * The company registers the app at https://supabase.com/dashboard/org/_/apps
 * with the instance callback URL ; the operator enters the client id and
 * secret in the instance configuration (P1.4). The plugin reads them from
 * `ctx.appConfig` at refresh time only.
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type OAuth2CredentialSpec,
  type OAuth2Secret,
} from '@vaubaan/plugin-sdk';

export const SUPABASE_OAUTH_AUTHORIZE_URL = 'https://api.supabase.com/v1/oauth/authorize';
export const SUPABASE_OAUTH_TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';

/** Keys of `ctx.appConfig` the host fills from the company's registered app. */
export const SUPABASE_APP_CONFIG_KEYS = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
} as const;

/** Refresh when the access token expires within this window (v4 value). */
export const REFRESH_THRESHOLD_MS = 60_000;

export const supabaseCredential: OAuth2CredentialSpec = {
  kind: 'oauth2',
  authorizationUrl: SUPABASE_OAUTH_AUTHORIZE_URL,
  tokenUrl: SUPABASE_OAUTH_TOKEN_URL,
  // The Management API grants the scopes chosen at app registration ; the
  // authorization request names the `all` scope, as the official guide does.
  scopes: ['all'],
  pkce: true,
  clientAuthMethod: 'client_secret_basic',
  refreshable: true,
};

/**
 * True when the access token is expired or expires within
 * `REFRESH_THRESHOLD_MS`. A secret without `expiresAt` never triggers a
 * proactive refresh ; the host still refreshes on `UpstreamAuthError`.
 */
export function shouldRefreshSupabaseCredential(
  secret: Pick<OAuth2Secret, 'expiresAt'>,
  nowMs: number,
): boolean {
  if (secret.expiresAt === null) return false;
  const expiresAt = Date.parse(secret.expiresAt);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - nowMs < REFRESH_THRESHOLD_MS;
}

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

/**
 * Exchange the refresh token for a fresh pair (`grant_type=refresh_token`,
 * client authenticated with HTTP Basic). Returns a new secret and never
 * mutates the input. 401 / 403 → `UpstreamAuthError` (the refresh token was
 * revoked) ; any other failure → `Error`.
 */
export async function refreshSupabaseCredential(ctx: ConnectionContext): Promise<OAuth2Secret> {
  const secret = expectCredentialKind('supabase', ctx.credential, 'oauth2');
  if (!secret.refreshToken) {
    throw new UpstreamAuthError('supabase: the connection holds no refresh token', 401);
  }
  const clientId = ctx.appConfig[SUPABASE_APP_CONFIG_KEYS.clientId];
  const clientSecret = ctx.appConfig[SUPABASE_APP_CONFIG_KEYS.clientSecret];
  if (!clientId || !clientSecret) {
    throw new Error(
      `supabase: app config incomplete — '${SUPABASE_APP_CONFIG_KEYS.clientId}' and ` +
        `'${SUPABASE_APP_CONFIG_KEYS.clientSecret}' are required to refresh a token`,
    );
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await ctx.fetch(SUPABASE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: secret.refreshToken,
    }).toString(),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    throw new UpstreamAuthError(
      `supabase refused the refresh token (HTTP ${res.status})`,
      res.status,
    );
  }
  if (!res.ok) throw new Error(`supabase token endpoint failed with HTTP ${res.status}`);
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) throw new Error('supabase token endpoint returned no access_token');
  const expiresAt =
    typeof json.expires_in === 'number'
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null;
  return {
    kind: 'oauth2',
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? secret.refreshToken,
    expiresAt,
    scopes: secret.scopes,
    metadata: secret.metadata,
  };
}
