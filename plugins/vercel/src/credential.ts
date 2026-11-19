/**
 * Credential of the `vercel` service : an access token, and either the team
 * it acts for or the one project it is scoped to.
 *
 * ADR : one-place-to-authorize-services-token-first (amended 2026-10-31 :
 *       grant wide at the service, the mission narrows ; amended 2026-11-11 :
 *       a token scoped to one project is accepted too ; amended 2026-11-14 :
 *       the narrowest key that fits the missions first, so "One project" is
 *       listed, and checked, before "Team").
 *
 * Read through Context7 on 2026-10-31 and 2026-11-11 (Vercel docs "Access
 * tokens", REST API reference) : a token is made on the Account Tokens page
 * with a Scope (Full Account, a team with All Projects, or one project of a
 * team) and an expiration ; `GET /v5/user/tokens/current` describes the
 * token, its `expiresAt` included ; `GET /v2/teams/{teamId}` names a team ;
 * `GET /v9/projects/{idOrName}` names a project and its `accountId`. "Team-
 * and project-scoped tokens do not require the teamId query parameter [...]
 * Vercel infers the team and project from the token's scope" ; a project-
 * scoped token is denied user-level resources, team-level resources and
 * other projects.
 *
 * Two alternatives on the connect form (`CredentialAlternative`), the
 * narrowest first : `project` asks the Project ID, `team` the Team ID. The host keeps only the chosen
 * one's field, so the mode is read from which field is there
 * (`vercelAuth`) : an account made before the alternatives holds
 * `team_id` and stays a team account, without migration.
 */

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  httpJson,
  isRecord,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
  type CredentialSecret,
} from '@vaubaan/plugin-sdk';

import { SERVICE_ID, VERCEL_API_BASE } from './identity.ts';

/** Where a person creates and deletes their access tokens. */
export const VERCEL_TOKENS_URL = 'https://vercel.com/account/tokens';

/** Vercel team ids are `team_` followed by an alphanumeric id. */
export const VERCEL_TEAM_ID_PATTERN = '^team_[A-Za-z0-9]+$';

/** Vercel project ids are `prj_` followed by an alphanumeric id. */
export const VERCEL_PROJECT_ID_PATTERN = '^prj_[A-Za-z0-9]+$';

/** Field names of the form, which `vercelAuth` reads back. */
const FIELD = { token: 'token', teamId: 'team_id', projectId: 'project_id' } as const;

const NAME_AND_TOKEN_STEP =
  'Open the page and name the token; make sure the scope selector at the top left shows your personal account.';

/** Where the token is made, in Vercel's own labels. */
const TOKENS_PATH = ['Account Settings', 'Tokens'] as const;

export const vercelCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'access token',
  createUrl: VERCEL_TOKENS_URL,
  fields: [
    {
      name: FIELD.token,
      label: 'Access token',
      secret: true,
      placeholder: 'vcp_…',
    },
    {
      name: FIELD.teamId,
      label: 'Team ID',
      secret: false,
      placeholder: 'team_…',
      pattern: VERCEL_TEAM_ID_PATTERN,
      help: 'Team Settings, General, Team ID. Every call through this account acts for this team, and a token can reach several.',
    },
    {
      name: FIELD.projectId,
      label: 'Project ID',
      secret: false,
      placeholder: 'prj_…',
      pattern: VERCEL_PROJECT_ID_PATTERN,
      help: 'Project Settings, General, Project ID. Every call through this account acts on this one project.',
    },
  ],
  alternatives: [
    {
      id: 'project',
      label: 'One project',
      help: 'A token scoped to one project: the account reaches that project only. One account per project.',
      fields: [FIELD.projectId],
      steps: [
        {
          do: 'Open the project on Vercel and copy the Project ID (prj_…).',
          path: ['Settings', 'General', 'Project ID'],
        },
        { do: NAME_AND_TOKEN_STEP, path: TOKENS_PATH, url: VERCEL_TOKENS_URL },
        { do: 'Choose the team that owns the project, then the project.', path: ['Scope'] },
      ],
    },
    {
      id: 'team',
      label: 'Team',
      help: 'Every project of the team, now and later; each mission names the ones it reaches, and every one depends on this key.',
      fields: [FIELD.teamId],
      steps: [
        {
          do: 'Open the team on Vercel and copy the Team ID (team_…).',
          path: ['Settings', 'General', 'Team ID'],
        },
        { do: NAME_AND_TOKEN_STEP, path: TOKENS_PATH, url: VERCEL_TOKENS_URL },
        { do: 'Choose the team, then All Projects.', path: ['Scope'] },
      ],
    },
  ],
  guide: {
    steps: [
      { do: 'Choose an expiration and create the token.', path: ['Create'] },
      { do: 'Copy the token and paste it here with the ID. Vercel shows it once.' },
    ],
    reach: {
      what: 'Scope',
      grant: 'One project, or the team with All Projects',
      why: 'A key per project keeps a leak or a mistake inside that project; one key for everything makes every mission depend on it. Choose the team when your missions span its projects.',
    },
    // A Vercel token carries no permission choice beyond its scope.
    permissions: [],
    expiry: { kind: 'service-reports' },
    docsUrl: 'https://vercel.com/docs/accounts/access-tokens',
  },
  verify: verifyVercelToken,
};

/**
 * What every call needs, narrowed from the decrypted secret : the token, and
 * the team it acts for or the one project it is scoped to.
 */
export type VercelAuth =
  | { readonly mode: 'team'; readonly token: string; readonly teamId: string }
  | { readonly mode: 'project'; readonly token: string; readonly projectId: string };

/**
 * Narrow the secret the host hands the plugin. The mode is the field that is
 * there : `team_id` (every account made before 2026-11-11 too) or
 * `project_id`. Throws `CredentialKindMismatch` on the wrong kind and a plain
 * `Error` when the token is missing, when neither or both ids are there, or
 * when one is malformed — all host bugs, not service errors, so none is an
 * `UpstreamAuthError`.
 */
export function vercelAuth(secret: CredentialSecret): VercelAuth {
  const apiKey = expectCredentialKind(SERVICE_ID, secret, 'api-key');
  const token = apiKey.fields[FIELD.token];
  const teamId = apiKey.fields[FIELD.teamId];
  const projectId = apiKey.fields[FIELD.projectId];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error("vercel credential: field 'token' is missing");
  }
  const hasTeam = typeof teamId === 'string' && teamId.length > 0;
  const hasProject = typeof projectId === 'string' && projectId.length > 0;
  if (hasTeam === hasProject) {
    throw new Error("vercel credential: expected exactly one of 'team_id' and 'project_id'");
  }
  if (hasTeam) {
    if (!new RegExp(VERCEL_TEAM_ID_PATTERN).test(teamId)) {
      throw new Error("vercel credential: field 'team_id' is not a 'team_…' id");
    }
    return { mode: 'team', token, teamId };
  }
  if (!new RegExp(VERCEL_PROJECT_ID_PATTERN).test(projectId!)) {
    throw new Error("vercel credential: field 'project_id' is not a 'prj_…' id");
  }
  return { mode: 'project', token, projectId: projectId! };
}

/**
 * What the form names, which the token must open, and the token's expiry
 * (`GET /v5/user/tokens/current`). Team mode : the expiry, then the team
 * (`GET /v2/teams/{teamId}`). Project mode : the project first
 * (`GET /v9/projects/{projectId}`, without `teamId` : Vercel infers it from
 * the token), then the expiry, unknown when Vercel answers 404 : a token
 * scoped to one project is denied user-level resources, and Vercel says so
 * with `404 Token not found` (seen 2026-11-19), not a 403. A refusal says
 * what to change.
 */
export async function verifyVercelToken(ctx: AccountContext): Promise<CredentialCheck> {
  const auth = vercelAuth(ctx.credential);
  if (auth.mode === 'team') {
    const current = await vercelGet(ctx, auth.token, '/v5/user/tokens/current');
    return { account: await teamAccount(ctx, auth), expiresAt: expiryOf(current) };
  }
  const account = await projectAccount(ctx, auth);
  let current: Readonly<Record<string, unknown>> | undefined;
  try {
    current = await vercelGet(ctx, auth.token, '/v5/user/tokens/current');
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return { account, expiresAt: current ? expiryOf(current) : null };
}

function expiryOf(current: Readonly<Record<string, unknown>>): string | null {
  const expiresAt = isRecord(current.token) ? current.token.expiresAt : undefined;
  return typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : null;
}

async function teamAccount(
  ctx: AccountContext,
  auth: Extract<VercelAuth, { mode: 'team' }>,
): Promise<string> {
  let team: Readonly<Record<string, unknown>>;
  try {
    team = await vercelGet(ctx, auth.token, `/v2/teams/${encodeURIComponent(auth.teamId)}`);
  } catch (err) {
    if (isForbidden(err)) {
      throw new CredentialRefusal(
        `Vercel: this token does not cover the whole team ${auth.teamId} (it may be scoped to one project): choose One project, or recreate it with the team and All Projects.`,
      );
    }
    if (isNotFound(err)) {
      throw new CredentialRefusal(
        `Vercel: no team with the ID ${auth.teamId}. Copy it from Team Settings, General, Team ID.`,
      );
    }
    throw err;
  }
  return `the ${firstName(team.name, team.slug) ?? auth.teamId} team`;
}

async function projectAccount(
  ctx: AccountContext,
  auth: Extract<VercelAuth, { mode: 'project' }>,
): Promise<string> {
  let project: Readonly<Record<string, unknown>>;
  try {
    project = await vercelGet(
      ctx,
      auth.token,
      `/v9/projects/${encodeURIComponent(auth.projectId)}`,
    );
  } catch (err) {
    if (isForbidden(err) || isNotFound(err)) {
      throw new CredentialRefusal(
        `Vercel: this token does not open the project ${auth.projectId}. Check the Project ID, and under Scope choose the team that owns it, then that project.`,
      );
    }
    throw err;
  }
  return `the ${firstName(project.name) ?? auth.projectId} project`;
}

function firstName(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v !== '');
}

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

function isForbidden(err: unknown): boolean {
  return err instanceof UpstreamAuthError && err.upstreamStatus === HTTP_FORBIDDEN;
}

function isNotFound(err: unknown): boolean {
  return err instanceof UpstreamHttpError && err.status === HTTP_NOT_FOUND;
}

/** One GET of the REST API ; every answer it reads is an object, its fields read one by one. */
async function vercelGet(
  ctx: AccountContext,
  token: string,
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  return httpJson(
    ctx,
    { url: `${VERCEL_API_BASE}${path}`, headers: { authorization: `Bearer ${token}` } },
    isRecord,
  );
}
