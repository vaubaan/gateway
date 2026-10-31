/**
 * Credential of the `vercel` provider : an access token plus the team it acts for.
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 :
 *       grant wide at the service, the mission narrows).
 *
 * Read through Context7 on 2026-10-31 (Vercel docs "Access tokens", REST API
 * reference) : a token is made on the Account Tokens page with a Scope (Full
 * Account, one team, or one project of a team) and an expiration ;
 * `GET /v5/user/tokens/current` describes the token, its `expiresAt`
 * included ; `GET /v2/teams/{teamId}` names a team.
 *
 * The team id stays a field of the form. Every call is pinned to one team
 * (`execute.ts`), and a token granted wide reaches every team of its owner,
 * so the person names the team ; the host keeps only what the form gives,
 * so a team found by `verify` could not be stored. `verify` checks that the
 * token opens that team and reads the expiry.
 */

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

/** The Vercel REST API (custom tools, discovery, the check at paste). A fact about the provider. */
export const VERCEL_API_BASE = 'https://api.vercel.com';

/** Where a person creates and deletes their access tokens. */
export const VERCEL_TOKENS_URL = 'https://vercel.com/account/tokens';

/** Vercel team ids are `team_` followed by an alphanumeric id. */
export const VERCEL_TEAM_ID_PATTERN = '^team_[A-Za-z0-9]+$';

export const vercelCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'access token',
  createUrl: VERCEL_TOKENS_URL,
  fields: [
    {
      name: 'token',
      label: 'Access token',
      secret: true,
      placeholder: 'vcp_…',
    },
    {
      name: 'team_id',
      label: 'Team ID',
      secret: false,
      placeholder: 'team_…',
      pattern: VERCEL_TEAM_ID_PATTERN,
      help: 'Team Settings, General, Team ID. Every call through this account acts for this team, and a token can reach several.',
    },
  ],
  guide: {
    steps: [
      {
        do: 'Open the team on Vercel, then Settings, General, and copy the Team ID (team_…).',
      },
      {
        do: 'Open Account Settings, Tokens, name the token, and under Scope choose the team, then All Projects.',
        url: VERCEL_TOKENS_URL,
      },
      { do: 'Choose an expiration and Create.' },
      { do: 'Copy the token and paste it here with the Team ID. Vercel shows it once.' },
    ],
    reach: {
      what: 'Scope',
      grant: 'The team, All Projects',
      why: 'This gateway gives a mission only the projects and permissions it names; a token scoped to one project cannot read the team and is refused.',
    },
    // A Vercel token carries no permission choice beyond its scope.
    permissions: [],
    expiry: { kind: 'provider-reports' },
    docsUrl: 'https://vercel.com/docs/accounts/access-tokens',
  },
  verify: verifyVercelToken,
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

interface TokenDto {
  readonly token?: { readonly expiresAt?: unknown };
}

interface TeamDto {
  readonly name?: unknown;
  readonly slug?: unknown;
}

/**
 * The token's expiry (`GET /v5/user/tokens/current`), then the team of the
 * form (`GET /v2/teams/{teamId}`), which the token must open : a token
 * scoped to one project, to another team, or a wrong Team ID is refused
 * with what to change.
 */
export async function verifyVercelToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const auth = vercelAuth(ctx.credential);
  const current = (await vercelGet(ctx, auth, '/v5/user/tokens/current')) as TokenDto;
  const team = await readTeamOrRefuse(ctx, auth);
  const name = [team.name, team.slug].find((v): v is string => typeof v === 'string' && v !== '');
  const expiresAt = current.token?.expiresAt;
  return {
    account: `the ${name ?? auth.teamId} team`,
    expiresAt: typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : null,
  };
}

async function readTeamOrRefuse(ctx: ConnectionContext, auth: VercelAuth): Promise<TeamDto> {
  try {
    return (await vercelGet(ctx, auth, `/v2/teams/${encodeURIComponent(auth.teamId)}`)) as TeamDto;
  } catch (err) {
    const status = err instanceof UpstreamAuthError ? err.upstreamStatus : null;
    const missing = err instanceof UpstreamHttpError && err.status === HTTP_NOT_FOUND;
    if (status === HTTP_FORBIDDEN || missing) {
      throw new CredentialRefusal(
        `Vercel: this token cannot open the team ${auth.teamId}. Check the Team ID, and under Scope choose that team with All Projects.`,
      );
    }
    throw err;
  }
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

async function vercelGet(ctx: ConnectionContext, auth: VercelAuth, path: string): Promise<unknown> {
  const res = await ctx.fetch(`${VERCEL_API_BASE}${path}`, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
    throw new UpstreamAuthError(`Vercel rejected the token (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new UpstreamHttpError(`Vercel GET ${path} failed with HTTP ${res.status}`, res.status);
  }
  return res.json();
}
