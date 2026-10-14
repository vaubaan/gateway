/**
 * GitHub sign-in (ADR github-sign-in): GitHub's OAuth web flow, which is not
 * OpenID Connect — there is no ID token, so the identity is read from the REST
 * API with the user's token, which is then dropped (never stored).
 *
 *   authorize   <issuer>/login/oauth/authorize?client_id&redirect_uri&scope&state
 *               &code_challenge&code_challenge_method=S256&allow_signup=false
 *   token       POST <issuer>/login/oauth/access_token (client secret, code, PKCE verifier)
 *   identity    GET <api>/user          subject = the numeric id (a login can be renamed
 *                                        and then taken by somebody else; the id cannot)
 *               GET <api>/user/emails   email = the PRIMARY address, refused unless
 *                                        GitHub verified it
 *   teams       GET <api>/orgs/<org>/teams/<team>/memberships/<login>, only for the
 *               team the admin rule names for this provider (`org/team`); `read:org`
 *               is asked for only then
 *
 * Scopes: `read:user user:email`, plus `read:org` when a team must be read. The
 * issuer recorded for the users is the provider's base URL (`https://github.com`,
 * or a GitHub Enterprise Server), whose REST API is `api.github.com` or
 * `<base>/api/v3` (`githubApiBase`).
 */
import { timingSafeEqual } from 'node:crypto';

import * as oidc from 'openid-client';

import { errorMessage } from '../config/errors';
import { githubApiBase, issuerKey, type GithubSignInProvider } from '../config/sign-in';
import type { IdentityClaims } from './claims';
import { LoginError } from './errors';
import type { CustomFetch, LoginChecks, StartedLogin } from './relying-party';

const BASE_SCOPES = ['read:user', 'user:email'] as const;
const TEAM_SCOPE = 'read:org';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'vaubaan-gateway';
const REQUEST_TIMEOUT_MS = 10_000;
/** `org/team-slug`, as GitHub prints a team. */
const TEAM = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export interface GithubSignInOptions {
  readonly redirectUri: URL;
  /** The teams to read at sign-in (`org/team`): those the admin rule names for this provider. */
  readonly teams: readonly string[];
  /** Routes the outbound HTTP (corporate proxy; an in-process GitHub in tests). */
  readonly fetch?: CustomFetch;
}

export interface FinishedGithubSignIn {
  readonly identity: IdentityClaims;
  readonly warnings: readonly string[];
}

/** The team names that can be read; the others are reported. */
export function readableTeams(teams: readonly string[]): {
  readable: { org: string; team: string; name: string }[];
  unreadable: string[];
} {
  const readable: { org: string; team: string; name: string }[] = [];
  const unreadable: string[] = [];
  for (const name of teams) {
    const match = TEAM.exec(name);
    if (match) readable.push({ org: match[1] ?? '', team: match[2] ?? '', name });
    else unreadable.push(name);
  }
  return { readable, unreadable };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class GithubSignIn {
  private readonly api: URL;
  private readonly fetchImpl: CustomFetch;

  constructor(
    private readonly provider: GithubSignInProvider,
    private readonly options: GithubSignInOptions,
  ) {
    this.api = githubApiBase(provider.issuer);
    this.fetchImpl =
      options.fetch ?? ((url, init) => fetch(url, init as unknown as RequestInit));
  }

  /** The scopes of an attempt: `read:org` only when a team must be read. */
  scopes(): string {
    const scopes: string[] = [...BASE_SCOPES];
    if (readableTeams(this.options.teams).readable.length > 0) scopes.push(TEAM_SCOPE);
    return scopes.join(' ');
  }

  async start(): Promise<StartedLogin> {
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const redirectTo = new URL(`${issuerKey(this.provider.issuer)}/login/oauth/authorize`);
    redirectTo.search = new URLSearchParams({
      client_id: this.provider.clientId,
      redirect_uri: this.options.redirectUri.href,
      scope: this.scopes(),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'false',
    }).toString();
    // GitHub's flow has no nonce: the state and the PKCE verifier bind the response.
    return { redirectTo, state, nonce: '', codeVerifier };
  }

  async finish(callbackUrl: URL, checks: LoginChecks): Promise<FinishedGithubSignIn> {
    const params = callbackUrl.searchParams;
    const error = params.get('error');
    const state = params.get('state') ?? '';
    if (!sameSecret(state, checks.state)) {
      throw new LoginError('state-mismatch', 'the "state" of the GitHub callback is not the one of the attempt');
    }
    if (error) {
      throw new LoginError(
        'idp-error',
        `${error}: ${params.get('error_description') ?? ''}`.trim(),
      );
    }
    const code = params.get('code');
    if (!code) throw new LoginError('idp-error', 'the GitHub callback carries no code');

    const token = await this.exchange(code, checks.codeVerifier);
    const warnings: string[] = [];
    const user = await this.get(token, '/user');
    const id = isRecord(user) ? user.id : undefined;
    const login = isRecord(user) && typeof user.login === 'string' ? user.login : null;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || login === null) {
      throw new LoginError('claims-missing', 'GitHub /user answered without a numeric id and a login');
    }
    const subject = String(id);
    const emails = await this.get(token, '/user/emails');
    const primary = Array.isArray(emails)
      ? emails.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.primary === true)
      : undefined;
    if (!primary || typeof primary.email !== 'string' || primary.email.trim() === '') {
      throw new LoginError(
        'email-not-verified',
        `GitHub user ${subject} has no primary email address the gateway could read`,
      );
    }
    if (primary.verified !== true) {
      throw new LoginError(
        'email-not-verified',
        `the primary email address of GitHub user ${subject} is not verified at GitHub`,
      );
    }
    const name = isRecord(user) && typeof user.name === 'string' && user.name.trim() ? user.name.trim() : login;
    const groups = await this.teamsOf(token, login, subject, warnings);
    return {
      identity: {
        issuer: issuerKey(this.provider.issuer),
        subject,
        email: primary.email.trim().toLowerCase(),
        emailVerified: true,
        displayName: name,
        groups,
      },
      warnings,
    };
  }

  /** The teams of the admin rule this user is an active member of; unknown is refused, never "none". */
  private async teamsOf(
    token: string,
    login: string,
    subject: string,
    warnings: string[],
  ): Promise<string[]> {
    const { readable, unreadable } = readableTeams(this.options.teams);
    for (const name of unreadable) {
      warnings.push(`the admin rule names "${name}", which is not a GitHub team (org/team): not read`);
    }
    const member: string[] = [];
    for (const { org, team, name } of readable) {
      const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`;
      const response = await this.request(token, path);
      if (response.status === 404) continue;
      if (!response.ok) {
        throw new LoginError(
          'groups-unavailable',
          `GitHub answered ${response.status} when asked whether user ${subject} is in team ${name} ` +
            '(the organisation may restrict OAuth apps, or the read:org scope was not granted)',
        );
      }
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && body.state === 'active') member.push(name);
    }
    return member;
  }

  private async exchange(code: string, codeVerifier: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${issuerKey(this.provider.issuer)}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: this.provider.clientId,
          client_secret: this.provider.clientSecret,
          code,
          redirect_uri: this.options.redirectUri.href,
          code_verifier: codeVerifier,
        }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LoginError('discovery-failed', `GitHub token endpoint: ${errorMessage(err)}`, { cause: err });
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || typeof body.access_token !== 'string') {
      const reason = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw new LoginError('idp-error', `GitHub refused the code: ${reason}`);
    }
    return body.access_token;
  }

  private async get(token: string, path: string): Promise<unknown> {
    const response = await this.request(token, path);
    if (!response.ok) throw new LoginError('idp-error', `GitHub ${path} answered ${response.status}`);
    return response.json().catch(() => null);
  }

  private async request(token: string, path: string): Promise<Response> {
    const url = `${this.api.href.replace(/\/$/, '')}${path}`;
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
        },
        body: undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LoginError('discovery-failed', `GitHub ${path}: ${errorMessage(err)}`, { cause: err });
    }
  }
}
