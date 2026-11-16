/**
 * Credential of the `github-projects` service : a fine-grained personal
 * access token pasted by hand (`api-key`), with the organization and the
 * number of the one project the account is for.
 *
 * ADR : github-projects-is-its-own-plugin (this file is a copy of the GitHub
 *       plugin's `credential.ts`, adapted ; a change to how GitHub tokens are
 *       checked is made to both) ; one-place-to-authorize-services-token-first.
 *
 * Written from GitHub's documentation, read 2026-11-16 : "Permissions
 * required for fine-grained personal access tokens" (organization permission
 * "Projects" serves every `/orgs/{org}/projectsV2/…` endpoint) and "REST API
 * endpoints for Projects".
 *
 * One account is one project. The "Projects" permission is an organization
 * permission : the token opens every project of the organization, and this
 * gateway keeps each mission to the account's one project. Items link issues
 * and pull requests of the organization's repositories, so the guide asks
 * for every repository with Issues and Pull requests read : the card shows
 * them, and an issue is added to the board by its repository and number.
 *
 * Checked at paste (`verifyGithubProjectsToken`) : `GET /user` names the
 * account, the `github-authentication-token-expiration` header gives the
 * expiry, and `GET /orgs/{org}/projectsV2/{number}` proves the token opens
 * the named project.
 */

import {
  CredentialRefusal,
  expectCredentialKind,
  httpJson,
  isRecord,
  isUpstreamHttpError,
  type AccountContext,
  type ApiKeyCredentialSpec,
  type CredentialCheck,
  type TokenPermission,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, githubApiHeaders } from './api.ts';
import { orgLogin, positiveId, type ProjectTarget } from './call.ts';
import { SERVICE_ID, TOOL } from './identity.ts';

/** Name of the form field, and key of the secret, holding the token. */
export const TOKEN_FIELD = 'token';
/** The organization that owns the project. */
export const ORGANIZATION_FIELD = 'organization';
/** The project's number, as in its address (`/orgs/<org>/projects/<number>`). */
export const PROJECT_FIELD = 'project';

/** Where a person manages their fine-grained tokens at GitHub. */
export const GITHUB_TOKENS_PAGE = 'https://github.com/settings/personal-access-tokens';

/** Response header carrying a personal access token's expiry, when GitHub sends it. */
export const GITHUB_TOKEN_EXPIRATION_HEADER = 'github-authentication-token-expiration';

/** Fine-grained tokens start with `github_pat_` ; classic ones (`ghp_`) are refused. */
export const GITHUB_FINE_GRAINED_TOKEN_PATTERN = '^github_pat_[A-Za-z0-9_]{20,255}$';

/**
 * The permissions to tick, as GitHub's token page names them, each with the
 * tools it serves. In the order of the page : repository permissions, then
 * organization permissions.
 */
export const GITHUB_PROJECTS_TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  {
    name: 'Issues',
    access: 'read',
    tools: [
      TOOL.listProjectItems,
      TOOL.getProjectItem,
      TOOL.listProjectViewItems,
      TOOL.addProjectItem,
    ],
  },
  {
    name: 'Pull requests',
    access: 'read',
    tools: [
      TOOL.listProjectItems,
      TOOL.getProjectItem,
      TOOL.listProjectViewItems,
      TOOL.addProjectItem,
    ],
  },
  {
    name: 'Projects',
    access: 'read-write',
    tools: Object.values(TOOL),
  },
];

export const githubProjectsCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'fine-grained personal access token',
  fields: [
    {
      name: TOKEN_FIELD,
      label: 'Fine-grained personal access token',
      secret: true,
      pattern: GITHUB_FINE_GRAINED_TOKEN_PATTERN,
      placeholder: 'github_pat_…',
      help: 'A classic token (ghp_…) is refused: it reaches every organization of its account.',
    },
    {
      name: ORGANIZATION_FIELD,
      label: 'Organization',
      secret: false,
      pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$',
      placeholder: 'my-organization',
      help: 'The organization that owns the project, as in its address on GitHub.',
    },
    {
      name: PROJECT_FIELD,
      label: 'Project number',
      secret: false,
      pattern: '^[1-9][0-9]{0,9}$',
      placeholder: '12',
      help: 'The number at the end of the project address: github.com/orgs/<organization>/projects/<number>. One account per project.',
    },
  ],
  createUrl: GITHUB_TOKENS_PAGE,
  guide: {
    steps: [
      {
        do: 'Sign in to GitHub as the account the agents will act as, a member of the organization.',
      },
      {
        do: 'Open the page and start a new fine-grained token.',
        path: [
          'Settings',
          'Developer settings',
          'Personal access tokens',
          'Fine-grained tokens',
          'Generate new token',
        ],
        url: GITHUB_TOKENS_PAGE,
      },
      { do: 'Choose the organization that owns the project.', path: ['Resource owner'] },
      {
        do: 'Choose All repositories, so the cards of every repository can be read.',
        path: ['Repository access', 'All repositories'],
      },
      {
        do: 'Tick every permission below at the access shown, under each of the two lists.',
        path: ['Permissions'],
      },
      {
        do: 'Generate the token, copy it, and paste it here with the organization and the project number. GitHub shows it once.',
        path: ['Generate token'],
      },
    ],
    permissions: GITHUB_PROJECTS_TOKEN_PERMISSIONS,
    reach: {
      what: 'Resource owner and repository access',
      grant: 'The organization, All repositories, Projects read and write',
      why: 'GitHub grants Projects for the whole organization, and a card can link an issue of any of its repositories. This gateway keeps every mission to the one project of this account, and to the acts it names.',
    },
    expiry: { kind: 'service-reports' },
    docsUrl:
      'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  verify: verifyGithubProjectsToken,
};

/** The pasted token. */
export function githubProjectsTokenOf(ctx: AccountContext): string {
  const secret = expectCredentialKind(SERVICE_ID, ctx.credential, 'api-key');
  const token = secret.fields[TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${SERVICE_ID}: the stored token has no '${TOKEN_FIELD}' field`);
  }
  return token;
}

/**
 * The project the account is for. A value outside the grammar is a host bug :
 * both fields' patterns are checked at paste.
 */
export function accountProjectOf(ctx: AccountContext): ProjectTarget {
  const secret = expectCredentialKind(SERVICE_ID, ctx.credential, 'api-key');
  const org = orgLogin(secret.fields[ORGANIZATION_FIELD]);
  const number = positiveId(secret.fields[PROJECT_FIELD]);
  if (org === null || number === null) {
    throw new Error(
      `${SERVICE_ID}: the stored '${ORGANIZATION_FIELD}' or '${PROJECT_FIELD}' is malformed`,
    );
  }
  return { org, number, ref: `${org}/${number}` };
}

/**
 * Who the token acts as and when it expires (`GET /user`, the expiration
 * header), then that it opens the named project. A 401 or 403 is a rejected
 * token (`UpstreamAuthError`) ; a 404 on the project a `CredentialRefusal`.
 */
export async function verifyGithubProjectsToken(ctx: AccountContext): Promise<CredentialCheck> {
  let expiration: string | null = null;
  const fetchKeepingExpiry: typeof fetch = async (input, init) => {
    const res = await ctx.fetch(input, { ...init, redirect: 'error' });
    expiration = res.headers.get(GITHUB_TOKEN_EXPIRATION_HEADER);
    return res;
  };
  const user = await httpJson(
    { fetch: fetchKeepingExpiry, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    { url: `${GITHUB_API_BASE}/user`, headers: githubApiHeaders(githubProjectsTokenOf(ctx)) },
    isRecord,
  );
  await fetchAccountProject(ctx);
  return {
    account: typeof user.login === 'string' ? user.login : null,
    expiresAt: expiryOf(expiration),
  };
}

/** `2026-12-31 00:00:00 UTC` (GitHub's format) ; anything else is "not said". */
export function expiryOf(header: string | null): string | null {
  if (!header) return null;
  const iso = header.trim().replace(' UTC', 'Z').replace(' ', 'T');
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

const HTTP_NOT_FOUND = 404;

/** `GET /orgs/{org}/projectsV2/{number}` : the account's project as GitHub answers it. */
export async function fetchAccountProject(ctx: AccountContext): Promise<Record<string, unknown>> {
  const project = accountProjectOf(ctx);
  const url = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(project.org)}/projectsV2/${project.number}`;
  try {
    return await httpJson(
      ctx,
      {
        url,
        headers: githubApiHeaders(githubProjectsTokenOf(ctx)),
        what: `${SERVICE_ID} GET project`,
      },
      isRecord,
    );
  } catch (err) {
    if (isUpstreamHttpError(err) && err.status === HTTP_NOT_FOUND) {
      throw new CredentialRefusal(
        `GitHub: this token does not open the project ${project.number} of ${project.org}. Check the organization and the number, and that the token's resource owner is ${project.org} with Projects: Read and write.`,
      );
    }
    throw err;
  }
}
