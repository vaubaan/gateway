/**
 * Credential of the `supabase` provider : OAuth 2.0 against the Management
 * API, through the OAuth app the company registered.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §5 (plugins declare how
 *        to obtain and refresh a credential), §7.2.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md D2.
 *
 * The host runs the authorization-code dance from `supabaseCredential`
 * (authorize URL, PKCE, state, token exchange) and the
 * refresh : Supabase's is the standard RFC 6749 `refresh_token` grant with
 * HTTP Basic client authentication, which the host performs from `tokenUrl`
 * + `clientAuthMethod` (`refreshable: true` is the whole declaration). The
 * plugin only keeps what is specific to Supabase : the endpoints and the
 * `all` scope the Management API expects. Access tokens live one hour ; the
 * refresh token rotates on every refresh.
 *
 * The company registers the app at https://supabase.com/dashboard/org/_/apps
 * with the instance callback URL ; the operator enters the client id and
 * secret in the instance configuration (P1.4).
 */

import type { OAuth2CredentialSpec } from '@vaubaan/plugin-sdk';

export const SUPABASE_OAUTH_AUTHORIZE_URL = 'https://api.supabase.com/v1/oauth/authorize';
export const SUPABASE_OAUTH_TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';

/** Keys of the app configuration the host fills from the company's registered app. */
export const SUPABASE_APP_CONFIG_KEYS = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
} as const;

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
