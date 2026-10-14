/**
 * The second way to connect Railway : an account token pasted by hand
 * (`api-key` kind), beside the company's Railway OAuth app.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.2 ; ADR
 *        token-connections-beside-the-integration-app.
 *
 * Which token (Railway public API docs, read through Context7 on 2026-10-14) :
 *   - account token ("No workspace") : every resource and workspace of its
 *     account, sent as `Authorization: Bearer` — the one chosen here ;
 *   - workspace token : one workspace, also a Bearer, but the documented
 *     identity query (`me`) and the documented personal project list are
 *     account-shaped, and nothing read says how a workspace token answers
 *     them ; not offered until that is checked against a real account ;
 *   - project token : one environment of one project, sent as
 *     `Project-Access-Token` ; one connection per environment would not match
 *     the plugin's resources (projects), and Railway's MCP server refuses it.
 *
 * What runs with it : the four variable tools and discovery (the public
 * GraphQL API documents account tokens). The ten tools rewrapped from
 * Railway's MCP server do not : Railway documents that server for OAuth and
 * for its CLI's own sign-in only. Sending it a token it may answer with 401
 * would expire a healthy connection, so they are declared unavailable on a
 * token connection and refused before the budget.
 *
 * Railway account tokens carry no permission choice and, in what was read,
 * no expiry ; removing an account says where to delete the token (no
 * deletion endpoint was read).
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

import { PROVIDER } from './classify.ts';
import { CUSTOM_TOOL_NAMES } from './custom-tools.ts';
import { railwayTools } from './tools.ts';

/** Name of the form field, and key of the secret, holding the token. */
export const RAILWAY_TOKEN_FIELD = 'api_token';

/** Where a person creates and deletes account tokens. */
export const RAILWAY_TOKENS_PAGE = 'https://railway.com/account/tokens';

const RAILWAY_GRAPHQL = 'https://backboard.railway.com/graphql/v2';

/** Why a tool rewrapped from Railway's MCP server does not run on a token connection. */
export const MCP_NEEDS_THE_APP =
  "needs the Railway OAuth app: this tool runs on Railway's MCP server, which Railway documents for OAuth sign-in only; ask an administrator to register your company's Railway app, then connect the account through it.";

/** The tools of Railway's MCP server : every declared tool that is not one of the four GraphQL ones. */
const MCP_TOOLS = railwayTools.map((t) => t.name).filter((name) => !CUSTOM_TOOL_NAMES.has(name));

export const railwayTokenCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'account token',
  fields: [
    {
      name: RAILWAY_TOKEN_FIELD,
      label: 'Account token',
      secret: true,
      pattern: '^[A-Za-z0-9_-]{20,200}$',
      help: 'Created with "No workspace" selected. A project token is refused by Railway for this use.',
    },
  ],
  createUrl: RAILWAY_TOKENS_PAGE,
  guide: {
    steps: [
      'Sign in to Railway as the account the agents will act as.',
      'Open Account settings, Tokens, and create a token with No workspace selected.',
      'Railway tokens carry no permission choice: the account reaches what its role allows, and Vaubaan decides who may do what.',
      'Copy the token and paste it here. Railway shows it once.',
    ],
    permissions: [],
    recommendedExpiryDays: null,
    docsUrl: 'https://docs.railway.com/integrations/api',
  },
  unavailableTools: Object.fromEntries(MCP_TOOLS.map((name) => [name, MCP_NEEDS_THE_APP])),
  manualRevocation:
    'Delete the token in Railway, signed in as the account that created it: Account settings, Tokens.',
  verify: verifyRailwayToken,
};

/** The bearer of a Railway connection, whichever way it was made. */
export function railwayBearerOf(credential: CredentialSecret): string {
  if (credential.kind === 'api-key') {
    const token = expectCredentialKind(PROVIDER, credential, 'api-key').fields[RAILWAY_TOKEN_FIELD];
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`railway: the stored token has no '${RAILWAY_TOKEN_FIELD}' field`);
    }
    return token;
  }
  return expectCredentialKind(PROVIDER, credential, 'oauth2').accessToken;
}

/**
 * Who the token acts as : `query { me { name email } }`, the documented first
 * call with an account token. A 401 or 403, or a GraphQL error (a project or
 * workspace token has no `me`), is a rejected token.
 */
export async function verifyRailwayToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const res = await ctx.fetch(RAILWAY_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${railwayBearerOf(ctx.credential)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: 'query { me { name email } }' }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(`railway rejected the token (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) throw new Error(`railway GraphQL answered HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { me?: { name?: unknown; email?: unknown } | null };
    errors?: ReadonlyArray<{ message?: unknown }>;
  };
  const me = body.data?.me;
  if (!me || (body.errors && body.errors.length > 0)) {
    const said = body.errors?.map((e) => String(e.message)).join('; ');
    throw new UpstreamAuthError(
      `railway did not accept it as an account token${said ? ` (${said})` : ''}`,
      401,
    );
  }
  const email = typeof me.email === 'string' ? me.email : null;
  const name = typeof me.name === 'string' ? me.name : null;
  return { account: email ?? name, expiresAt: null };
}
