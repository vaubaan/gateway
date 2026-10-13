/**
 * Credential of the `gmail` provider — Google OAuth 2.0 authorization code
 * with PKCE, against the company's own Google Cloud OAuth client.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md D2.
 *
 * The host runs the whole flow from `gmailCredentialSpec` : Google's
 * authorization endpoint, the token endpoint with `client_secret` in the POST
 * body (Google's documented method), PKCE S256, `access_type=offline` plus
 * `prompt=consent` so a refresh token is issued on every connect, and
 * `include_granted_scopes=true` for incremental authorization. Access tokens
 * live one hour ; the token endpoint answers `expires_in`.
 *
 * Scopes follow the handbook decision ("Credential and discovery") : `gmail.readonly` and
 * `gmail.compose` only — enough for every read tool and for `create_draft`.
 * `gmail.modify` (needed upstream by `label_*` and also unlocking `send`) and
 * `gmail.send` are **not** requested : opening them is an incremental
 * authorization decided by ADR when the execution phase lands. The label
 * tools are therefore classified today but would be refused upstream.
 *
 * The plugin implements no provider-specific refresh : Google's refresh is
 * the standard RFC 6749 `refresh_token` grant the host performs from
 * `tokenUrl` + `clientAuthMethod` (`refreshable: true` is the whole
 * declaration).
 */

import type { OAuth2CredentialSpec } from '@vaubaan/plugin-sdk';

export const GMAIL_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Gmail REST API base, used by `discoverResources`. */
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

export const GMAIL_SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';

/** The scopes requested at connect time (handbook, "Credential and discovery"). */
export const GMAIL_SCOPES: readonly string[] = [GMAIL_SCOPE_READONLY, GMAIL_SCOPE_COMPOSE];

/** Keys of `ProviderAppConfig` the host collects for every oauth2 plugin. */
export const GMAIL_APP_CONFIG_KEYS = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
} as const;

export const gmailCredentialSpec: OAuth2CredentialSpec = {
  kind: 'oauth2',
  authorizationUrl: GMAIL_AUTHORIZATION_URL,
  tokenUrl: GMAIL_TOKEN_URL,
  scopes: GMAIL_SCOPES,
  pkce: true,
  clientAuthMethod: 'client_secret_post',
  refreshable: true,
  extraAuthorizationParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
};
