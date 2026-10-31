/**
 * Credential of the `github` provider : a fine-grained personal access token
 * pasted by hand (`api-key` kind), the one way of connecting GitHub.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Connection", §7.2 ; ADR
 *        one-place-to-authorize-services-token-first.
 *
 * A person creates a token at GitHub — often on a shared service account —
 * over all the repositories of the organization, with every permission the
 * tools use, and pastes it : this gateway decides, mission by mission, what
 * an agent may do with it. The token is the
 * connection's secret ; every API tool and the git remote send it as the
 * bearer. GitHub enforces what it may do : the permissions its owner ticked.
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
  expectCredentialKind,
  httpJson,
  isRecord,
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, githubApiHeaders } from './api.ts';
import { PROVIDER_ID } from './identity.ts';
import { GITHUB_TOKEN_PERMISSIONS } from './permissions.ts';

/** Name of the form field, and key of the secret, holding the token. */
export const GITHUB_TOKEN_FIELD = 'token';

/** Where a person manages their fine-grained tokens at GitHub. */
export const GITHUB_TOKENS_PAGE = 'https://github.com/settings/personal-access-tokens';

/** Response header carrying a personal access token's expiry, when GitHub sends it. */
export const GITHUB_TOKEN_EXPIRATION_HEADER = 'github-authentication-token-expiration';

/** Fine-grained tokens start with `github_pat_` ; classic ones (`ghp_`) are refused. */
export const GITHUB_FINE_GRAINED_TOKEN_PATTERN = '^github_pat_[A-Za-z0-9_]{20,255}$';

export const githubCredential: ApiKeyCredentialSpec = {
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
      { do: 'Sign in to GitHub as the account the agents will act as.' },
      {
        do: 'Open Settings, Developer settings, Personal access tokens, Fine-grained tokens, then Generate new token.',
        url: GITHUB_TOKENS_PAGE,
      },
      {
        do: 'Choose the organization as Resource owner, then All repositories.',
      },
      {
        do: 'Tick every permission below at the access shown; GitHub adds Metadata (read) by itself.',
      },
      { do: 'Generate the token, copy it, and paste it here. GitHub shows it once.' },
    ],
    permissions: GITHUB_TOKEN_PERMISSIONS,
    reach: {
      what: 'Repository access',
      grant: 'All repositories of the resource owner, with every permission below',
      why: 'GitHub is the ceiling and each mission the narrowing: this gateway gives an agent only the repositories and permissions its mission names, and a token that lacks one means a new token.',
    },
    expiry: { kind: 'provider-reports' },
    docsUrl:
      'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  verify: verifyGithubToken,
};

/** The pasted token of a token connection. */
export function githubTokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const token = secret.fields[GITHUB_TOKEN_FIELD];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`github: the stored token has no '${GITHUB_TOKEN_FIELD}' field`);
  }
  return token;
}

/**
 * Who the token acts as and when it expires : `GET /user` (any valid token
 * may read its own user) and the expiration header. A 401 or a 403 is a
 * rejected token (`UpstreamAuthError`) ; any other failure is GitHub's.
 */
export async function verifyGithubToken(ctx: ConnectionContext): Promise<CredentialCheck> {
  // `httpJson` reads the body ; the expiry is a header of the same answer,
  // kept by the fetch it is given.
  let expiration: string | null = null;
  const fetchKeepingExpiry: typeof fetch = async (input, init) => {
    const res = await ctx.fetch(input, { ...init, redirect: 'error' });
    expiration = res.headers.get(GITHUB_TOKEN_EXPIRATION_HEADER);
    return res;
  };
  const user = await httpJson(
    { fetch: fetchKeepingExpiry, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    { url: `${GITHUB_API_BASE}/user`, headers: githubApiHeaders(githubTokenOf(ctx)) },
    isRecord,
  );
  return {
    account: typeof user.login === 'string' ? user.login : null,
    expiresAt: expiryOf(expiration),
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
