/**
 * The second way to connect GitHub : a fine-grained personal access token
 * pasted by hand (`api-key` kind), beside the company's GitHub App.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.2 ; ADR
 *        token-connections-beside-the-integration-app.
 *
 * When the company registered no GitHub App, a person creates a token at
 * GitHub — often on a shared service account, with Vaubaan deciding who may
 * do what — and pastes it. The token is the connection's secret ; every API
 * tool sends it as the bearer. Only `github__mint_install_token` cannot run :
 * it hands out an installation token, which only an App can mint.
 *
 * Fine-grained tokens only. A classic token (`ghp_`) reaches every
 * repository and organisation of its account with coarse scopes and may
 * never expire ; a fine-grained one names its resource owner, its
 * repositories and its permissions, and GitHub recommends it. The field's
 * pattern refuses a classic token before anything is sent.
 *
 * Checked at paste (`verifyGithubToken`) : `GET /user` names the account ;
 * the `github-authentication-token-expiration` response header, when GitHub
 * sends one, gives the expiry. The repositories it reaches are the
 * resources (`GET /user/repos`, discovery).
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import { MINT_TOOL } from './call.ts';

/** Name of the form field, and key of the secret, holding the token. */
export const GITHUB_TOKEN_FIELD = 'token';

/** Where a person manages their fine-grained tokens at GitHub. */
export const GITHUB_TOKENS_PAGE = 'https://github.com/settings/personal-access-tokens';

/** Response header carrying a personal access token's expiry, when GitHub sends it. */
export const GITHUB_TOKEN_EXPIRATION_HEADER = 'github-authentication-token-expiration';

/** Fine-grained tokens start with `github_pat_` ; classic ones (`ghp_`) are refused. */
export const GITHUB_FINE_GRAINED_TOKEN_PATTERN = '^github_pat_[A-Za-z0-9_]{20,255}$';

/** What the person reads when an agent asks for a tool the token cannot run. */
export const MINT_NEEDS_THE_APP =
  "needs the GitHub App: only an App mints the short-lived installation token this tool hands to git; ask an administrator to register your company's GitHub App, then connect the account through it.";

export const githubTokenCredential: ApiKeyCredentialSpec = {
  kind: 'api-key',
  label: 'fine-grained personal access token',
  fields: [
    {
      name: GITHUB_TOKEN_FIELD,
      label: 'Fine-grained personal access token',
      secret: true,
      pattern: GITHUB_FINE_GRAINED_TOKEN_PATTERN,
      placeholder: 'github_pat_…',
      help: 'A classic token (ghp_…) is refused: it reaches every repository of its account.',
    },
  ],
  createUrl: GITHUB_TOKENS_PAGE,
  guide: {
    steps: [
      'Sign in to GitHub as the account the agents will act as; a shared service account is fine.',
      'Open Settings, Developer settings, Personal access tokens, Fine-grained tokens, then Generate new token.',
      'Choose the organisation as resource owner, and only the repositories the missions need.',
      'Tick the permissions below; GitHub adds Metadata (read) by itself.',
      'Generate the token, copy it, and paste it here. GitHub shows it once.',
    ],
    permissions: [
      {
        name: 'Contents',
        access: 'read',
        tools: [
          'github__list_branches',
          'github__list_commits',
          'github__get_file_contents',
          'github__get_commit',
          'github__search_code',
          'github__list_releases',
          'github__list_tags',
        ],
      },
      {
        name: 'Contents',
        access: 'read-write',
        tools: [
          'github__create_branch',
          'github__create_or_update_file',
          'github__push_files',
          'github__delete_file',
          'github__merge_pull_request',
          'github__create_release',
          'github__delete_release',
        ],
      },
      {
        name: 'Pull requests',
        access: 'read',
        tools: ['github__list_pull_requests', 'github__get_pull_request'],
      },
      {
        name: 'Pull requests',
        access: 'read-write',
        tools: ['github__create_pull_request', 'github__merge_pull_request'],
      },
      {
        name: 'Issues',
        access: 'read',
        tools: ['github__list_issues', 'github__get_issue', 'github__search_issues'],
      },
      { name: 'Issues', access: 'read-write', tools: ['github__add_issue_comment'] },
      {
        name: 'Actions',
        access: 'read',
        tools: ['github__list_workflows', 'github__list_workflow_runs'],
      },
      {
        name: 'Workflows',
        access: 'read-write',
        tools: ['github__create_or_update_file', 'github__push_files'],
      },
      {
        name: 'Administration',
        access: 'read-write',
        tools: ['github__get_branch_protection', 'github__update_branch_protection'],
      },
    ],
    recommendedExpiryDays: 90,
    docsUrl:
      'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  unavailableTools: { [MINT_TOOL]: MINT_NEEDS_THE_APP },
  manualRevocation:
    'Delete the token at GitHub, signed in as the account that created it: Settings, Developer settings, Personal access tokens, Fine-grained tokens.',
  verify: verifyGithubToken,
};

/** The pasted token of a token connection. */
export function githubTokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind('github', ctx.credential, 'api-key');
  const token = secret.fields[GITHUB_TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`github: the stored token has no '${GITHUB_TOKEN_FIELD}' field`);
  }
  return token;
}

/**
 * Who the token acts as and when it expires : `GET /user` (any valid token
 * may read its own user) and the expiration header. A 401 is a rejected
 * token ; any other failure is GitHub's.
 */
export async function verifyGithubToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  const res = await ctx.fetch(`${GITHUB_API_BASE}/user`, {
    method: 'GET',
    headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${githubTokenOf(ctx)}` },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(`github rejected the token (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new UpstreamHttpError(`github GET /user failed with HTTP ${res.status}`, res.status);
  }
  const body = (await res.json()) as { login?: unknown };
  return {
    account: typeof body.login === 'string' ? body.login : null,
    expiresAt: expiryOf(res.headers.get(GITHUB_TOKEN_EXPIRATION_HEADER)),
  };
}

/**
 * The header reads `2026-12-31 00:00:00 UTC` (GitHub's format) ; anything
 * `Date` cannot read is taken as "not said" rather than guessed.
 */
export function expiryOf(header: string | null): string | null {
  if (!header) return null;
  const iso = header.trim().replace(' UTC', 'Z').replace(' ', 'T');
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
