/**
 * How a Miro account is made : the person signs in at Miro and allows
 * this gateway (`oauth2`), through the OAuth 2.1 authorization server of
 * Miro's MCP server. The gateway registers its own client there the first
 * time someone connects (RFC 7591 dynamic client registration) : no Miro app
 * to create, nothing to paste, no administrator step.
 *
 * Handbook : docs/handbook/providers/miro.md.
 * ADR      : docs/decisions/oauth-client-registered-by-the-gateway.md.
 *
 * Facts, from `https://mcp.miro.com/.well-known/oauth-authorization-server`
 * read unauthenticated on 2026-10-21 : authorization-code and refresh-token
 * grants, PKCE S256, token endpoint authentication `client_secret_post` or
 * `client_secret_basic` (no public client), scopes `boards:read
 * boards:write openid email`, registration endpoint `/register` (a test
 * registration answered 201 with a client id and secret, no expiry). Miro
 * asks the person to choose ONE team on its consent page : an account is one
 * Miro team. Access tokens are short-lived and refreshed (Miro's enterprise
 * guide) ; their lifetime is not published (⚠).
 */

import type { OAuth2RegisteredClientSpec } from '@vaubaan/plugin-sdk';

import { MIRO_OAUTH } from './identity.ts';

/** The two scopes the tools need, and nothing else (no `openid`, no `email`). */
export const REQUIRED_SCOPES = ['boards:read', 'boards:write'] as const;

export const miroCredential: OAuth2RegisteredClientSpec = {
  kind: 'oauth2',
  authorizationUrl: MIRO_OAUTH.authorizationUrl,
  tokenUrl: MIRO_OAUTH.tokenUrl,
  clientRegistration: { registrationUrl: MIRO_OAUTH.registrationUrl },
  scopes: REQUIRED_SCOPES,
  pkce: true,
  // RFC 8707 : the MCP server is the audience of the token (MCP authorization, 2025-06-18).
  resourceIndicator: MIRO_OAUTH.resource,
  clientAuthMethod: 'client_secret_post',
  refreshable: true,
};
