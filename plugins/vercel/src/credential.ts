/**
 * Credential of the `vercel` provider : an access token plus the team it acts for.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md D2.
 *
 * Vercel has no OAuth app flow that an on-prem instance can register for the
 * REST API and the MCP server at once ; what works is a **personal access
 * token** pasted by the user, scoped to one team. It is declared as an
 * `api-key` credential with two fields : the token (secret) and
 * the team id (not secret). The team id is required because almost every
 * upstream call takes `teamId`, and because a token created with full
 * account scope could otherwise be pointed at any team the user belongs to.
 * The host runs the form ; the plugin only declares it.
 */

import {
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

export const VERCEL_TOKENS_URL = 'https://vercel.com/account/settings/tokens';

/** Vercel team ids are `team_` followed by an alphanumeric id. */
export const VERCEL_TEAM_ID_PATTERN = '^team_[A-Za-z0-9]+$';

export const vercelCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  createUrl: VERCEL_TOKENS_URL,
  fields: [
    {
      name: 'token',
      label: 'Access token',
      secret: true,
      help: 'Create a token in Account Settings → Tokens, scoped to the team you connect. Pick an expiration; the account needs reconnecting when it passes.',
    },
    {
      name: 'team_id',
      label: 'Team ID',
      secret: false,
      placeholder: 'team_…',
      pattern: VERCEL_TEAM_ID_PATTERN,
      help: 'Team Settings → General → Team ID. Every call through this account is made on behalf of this team.',
    },
  ],
};

/** The two facts every call needs, narrowed from the decrypted secret. */
export interface VercelAuth {
  readonly token: string;
  readonly teamId: string;
}

/**
 * Narrow the secret the host hands the plugin. Throws `CredentialKindMismatch`
 * on the wrong kind and a plain `Error` when a field is missing — both mean
 * a host bug, not a provider error, so neither is an `UpstreamAuthError`.
 */
export function vercelAuth(secret: CredentialSecret): VercelAuth {
  const apiKey = expectCredentialKind('vercel', secret, 'api-key');
  const token = apiKey.fields.token;
  const teamId = apiKey.fields.team_id;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error("vercel credential: field 'token' is missing");
  }
  if (typeof teamId !== 'string' || !new RegExp(VERCEL_TEAM_ID_PATTERN).test(teamId)) {
    throw new Error("vercel credential: field 'team_id' is missing or is not a 'team_…' id");
  }
  return { token, teamId };
}
