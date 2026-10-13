/**
 * Credential of the `railway` provider — OAuth2 authorization code + PKCE,
 * with the RFC 8707 resource indicator on every token request.
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
 * Railway access tokens live one hour. The refresh is the standard RFC 6749
 * `refresh_token` grant with Basic client authentication and the same
 * `resource` parameter ; the host performs it from `tokenUrl`,
 * `clientAuthMethod` and `resourceIndicator` (`refreshable: true` is the
 * whole declaration), so the plugin implements no `refresh`.
 */

import type { OAuth2CredentialSpec } from '@vaubaan/plugin-sdk';

export const RAILWAY_AUTHORIZATION_URL = 'https://backboard.railway.com/oauth/auth';
export const RAILWAY_TOKEN_URL = 'https://backboard.railway.com/oauth/token';
/** RFC 8707 resource indicator binding the token to the MCP audience. */
export const RAILWAY_MCP_RESOURCE = 'https://mcp.railway.com';
export const RAILWAY_SCOPES: readonly string[] = ['openid', 'offline_access', 'workspace:member'];
/**
 * Refresh when the access token is within this window of expiry. Read by the
 * legacy v4 adapter only ; the v5 host owns the refresh timing.
 */
export const RAILWAY_REFRESH_THRESHOLD_MS = 60_000;

/** Keys of `ProviderAppConfig` the host collects for every oauth2 plugin. */
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
