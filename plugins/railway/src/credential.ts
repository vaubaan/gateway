/**
 * Credential of the `railway` provider : a token pasted by hand (`api-key`
 * kind), the one way of connecting.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2 ; ADRs
 *        one-place-to-authorize-services-token-first.
 *
 * Which token (all three are created under Account settings, Tokens) :
 *   - workspace token (a workspace selected) : that workspace only — the
 *     recommended one, least privilege, fit for a shared service account.
 *     Checked on 2026-10-14 against the real service : Railway's MCP server
 *     accepts it as `Authorization: Bearer` (`tools/call list-projects`
 *     answered the workspace's project ; a bogus Bearer got 401) ;
 *   - account token ("No workspace") : every workspace of its account, also
 *     a Bearer ; documented for the public GraphQL API, not checked against
 *     the MCP server (Railway documents that server for OAuth and its CLI's
 *     sign-in only) — accepted as the second choice ;
 *   - project token : one environment of one project, sent as
 *     `Project-Access-Token` ; one connection per environment would not match
 *     the plugin's resources (projects) ; not accepted.
 *
 * Both kinds run every tool. The form takes either ; the check at paste tells
 * them apart (`probeRailwayToken`) : `me` answers for an account token only,
 * a workspace token answers the projects of its workspace. When the MCP
 * server refuses a token that the API still accepts (an account token, if
 * Railway's MCP server turns out not to take them), the call fails as "not
 * permitted" (403) naming the token kind, so a healthy connection is not
 * expired for every tool ; a token the API refuses too is a rejected
 * credential (401), the existing "needs reconnecting" path.
 *
 * Railway tokens carry no permission choice and, in what was read, no
 * expiry ; removing an account says where to delete the token (no deletion
 * endpoint was read).
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
import { RAILWAY_USER_AGENT } from './user-agent.ts';

/** Name of the form field, and key of the secret, holding the token. */
export const RAILWAY_TOKEN_FIELD = 'api_token';

/** Where a person creates and deletes workspace and account tokens. */
export const RAILWAY_TOKENS_PAGE = 'https://railway.com/account/tokens';

const RAILWAY_GRAPHQL = 'https://backboard.railway.com/graphql/v2';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** The two kinds of Railway token the form accepts, recommended first. */
export const RAILWAY_TOKEN_KINDS = ['workspace', 'account'] as const;
export type RailwayTokenKind = (typeof RAILWAY_TOKEN_KINDS)[number];

export const railwayCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'workspace token',
  fields: [
    {
      name: RAILWAY_TOKEN_FIELD,
      label: 'Workspace token',
      secret: true,
      pattern: '^[A-Za-z0-9_-]{20,200}$',
      help: 'A workspace token is recommended; an account token works too. A project token is not accepted.',
    },
  ],
  createUrl: RAILWAY_TOKENS_PAGE,
  guide: {
    steps: [
      'Sign in to Railway as the account the agents will act as; a shared service account that is a member of the workspace is fine.',
      'Open Account settings, Tokens, and create a token with the workspace selected: a workspace token reaches that workspace only.',
      'An account token, created with No workspace selected, works too but reaches every workspace of the account. A project token is not accepted: it reaches one environment of one project.',
      'Railway tokens carry no permission choice: the token reaches what its workspace or account allows, and Vaubaan decides who may do what.',
      'Copy the token and paste it here. Railway shows it once.',
    ],
    permissions: [],
    recommendedExpiryDays: null,
    docsUrl: 'https://docs.railway.com/integrations/api',
  },
  verify: verifyRailwayToken,
};

/** The bearer of a Railway connection : the pasted token. */
export function railwayBearerOf(credential: CredentialSecret): string {
  const token = expectCredentialKind(PROVIDER, credential, 'api-key').fields[RAILWAY_TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`railway: the stored token has no '${RAILWAY_TOKEN_FIELD}' field`);
  }
  return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL, answered or refused
// ─────────────────────────────────────────────────────────────────────────────

/** A GraphQL answer, or what Railway said when it refused the token. */
export type GraphqlAnswer<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly said: string };

/**
 * One GraphQL request whose refusal is an answer, not an exception : a 401 or
 * 403, GraphQL `errors` or no `data` come back as `{ ok: false }`. Any other
 * failed status is thrown — Railway did not answer, which says nothing of the
 * token.
 */
export async function askRailwayGraphql<T>(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<GraphqlAnswer<T>> {
  const res = await fetchImpl(RAILWAY_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': RAILWAY_USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
    ...(signal ? { signal } : {}),
  });
  if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
    return { ok: false, said: `HTTP ${res.status}` };
  }
  if (!res.ok) throw new Error(`railway GraphQL answered HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: T | null;
    errors?: ReadonlyArray<{ message?: unknown }>;
  };
  if (body.errors && body.errors.length > 0) {
    return { ok: false, said: body.errors.map((e) => String(e.message)).join('; ') };
  }
  if (body.data === undefined || body.data === null) return { ok: false, said: 'no data' };
  return { ok: true, data: body.data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Which token it is
// ─────────────────────────────────────────────────────────────────────────────

/** What Railway's API says of a pasted token. */
export type RailwayTokenProbe =
  | { readonly kind: RailwayTokenKind; readonly account: string | null }
  | { readonly kind: 'rejected'; readonly said: string };

const OWNER_QUERY = /* GraphQL */ `
  query vaubaanTokenOwner {
    me {
      name
      email
    }
  }
`;

/** The projects a workspace token reaches : the fields discovery reads anyway. */
const REACH_QUERY = /* GraphQL */ `
  query vaubaanTokenReach {
    projects(first: 100) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

/** The workspace of those projects ; a name only, asked apart so its absence refuses nothing. */
const WORKSPACE_NAME_QUERY = /* GraphQL */ `
  query vaubaanTokenWorkspace {
    projects(first: 1) {
      edges {
        node {
          workspace {
            name
          }
        }
      }
    }
  }
`;

interface OwnerAnswer {
  readonly me?: { readonly name?: unknown; readonly email?: unknown } | null;
}
interface ReachAnswer {
  readonly projects?: {
    readonly edges?: ReadonlyArray<{ readonly node?: { readonly name?: unknown } }>;
  };
}
interface WorkspaceNameAnswer {
  readonly projects?: {
    readonly edges?: ReadonlyArray<{
      readonly node?: { readonly workspace?: { readonly name?: unknown } | null };
    }>;
  };
}

const PROJECTS_NAMED = 3;

/**
 * Which token this is, and whom it acts as. `me` answers → an account token,
 * named by its email (else its name). Otherwise the projects it reaches
 * answer → a workspace token, named by its workspace (else by the projects
 * it reaches). Neither → rejected.
 */
export async function probeRailwayToken(
  fetchImpl: typeof fetch,
  token: string,
  signal?: AbortSignal,
): Promise<RailwayTokenProbe> {
  const owner = await askRailwayGraphql<OwnerAnswer>(fetchImpl, token, OWNER_QUERY, {}, signal);
  if (owner.ok && owner.data.me) {
    const { email, name } = owner.data.me;
    const account = typeof email === 'string' ? email : typeof name === 'string' ? name : null;
    return { kind: 'account', account };
  }
  const reach = await askRailwayGraphql<ReachAnswer>(fetchImpl, token, REACH_QUERY, {}, signal);
  if (!reach.ok) {
    const said = owner.ok ? reach.said : `${owner.said}; ${reach.said}`;
    return { kind: 'rejected', said };
  }
  const workspace = await workspaceNameOf(fetchImpl, token, signal);
  if (workspace !== null) return { kind: 'workspace', account: `the ${workspace} workspace` };
  const projects = (reach.data.projects?.edges ?? [])
    .map((edge) => edge.node?.name)
    .filter((name): name is string => typeof name === 'string');
  if (projects.length === 0) return { kind: 'workspace', account: null };
  const named = projects.slice(0, PROJECTS_NAMED).join(', ');
  const more =
    projects.length > PROJECTS_NAMED ? ` and ${projects.length - PROJECTS_NAMED} more` : '';
  return { kind: 'workspace', account: `the workspace of ${named}${more}` };
}

async function workspaceNameOf(
  fetchImpl: typeof fetch,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const answer = await askRailwayGraphql<WorkspaceNameAnswer>(
    fetchImpl,
    token,
    WORKSPACE_NAME_QUERY,
    {},
    signal,
  );
  if (!answer.ok) return null;
  const name = answer.data.projects?.edges?.[0]?.node?.workspace?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * The check at paste : a workspace or an account token, and whom it acts as.
 * A token Railway's API refuses either way throws `UpstreamAuthError`.
 */
export async function verifyRailwayToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const probe = await probeRailwayToken(ctx.fetch, railwayBearerOf(ctx.credential), ctx.signal);
  if (probe.kind === 'rejected') {
    throw new UpstreamAuthError(
      `railway accepted it neither as a workspace token nor as an account token (${probe.said})`,
      HTTP_UNAUTHORIZED,
    );
  }
  return { account: probe.account, expiresAt: null };
}

/**
 * What a refusal of Railway's MCP server means for a pasted token, once the
 * API is asked about the same token :
 *   - the API refuses it too → the token is dead : 401, the host's
 *     rejected-credential path ("needs reconnecting") ;
 *   - the API still accepts it → the MCP server does not take this kind of
 *     token : 403 (not permitted), the connection stays usable for the
 *     variable tools, and the message names the kind and the way out.
 * A probe that cannot reach Railway leaves the original refusal as it was.
 */
export async function explainMcpRefusal(
  fetchImpl: typeof fetch,
  token: string,
  refusal: UpstreamAuthError,
  signal?: AbortSignal,
): Promise<UpstreamAuthError> {
  let probe: RailwayTokenProbe;
  try {
    probe = await probeRailwayToken(fetchImpl, token, signal);
  } catch {
    return refusal;
  }
  const status = refusal.upstreamStatus;
  if (probe.kind === 'rejected') {
    return new UpstreamAuthError(
      `Railway refused this account's token on its MCP server (HTTP ${status}) and on its API: it was deleted or has expired. Reconnect the account with a new workspace token.`,
      HTTP_UNAUTHORIZED,
    );
  }
  const wayOut =
    probe.kind === 'account'
      ? 'Railway accepts workspace tokens there: reconnect the account with a workspace token.'
      : 'Check that the token still belongs to a member of the workspace, or reconnect the account with a new workspace token.';
  return new UpstreamAuthError(
    `Railway's MCP server refused this ${probe.kind} token (HTTP ${status}) while Railway's API accepts it; the variable tools still run. ${wayOut}`,
    HTTP_FORBIDDEN,
  );
}
