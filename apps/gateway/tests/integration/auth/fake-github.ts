/**
 * An in-process GitHub for the sign-in tests: the OAuth web flow and the three
 * REST endpoints the gateway reads, laid out as a GitHub Enterprise Server
 * (`<base>/login/oauth/*`, `<base>/api/v3/*`) so that one origin serves both.
 * No listener: it is handed to the instance as the sign-in `fetch`
 * (`RootDeps.oidc.fetch`), next to the `FakeIdp` (`routeFetch`). The "browser"
 * step (`authorize()`) consents for the user and returns the callback URL
 * GitHub would redirect to.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { CustomFetch } from '../../../src/server/auth/relying-party';

export interface FakeGithubUser {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  /** Every address of the account; GitHub marks one primary. */
  readonly emails: readonly { email: string; primary: boolean; verified: boolean }[];
  /** Teams the user is an active member of, `org/team`. */
  readonly teams?: readonly string[];
}

interface IssuedCode {
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly user: FakeGithubUser;
  consumed: boolean;
}

export class FakeGithub {
  readonly base: URL;
  /** Who consents next. */
  nextUser: FakeGithubUser | null = null;
  /** When set, the team-membership endpoint answers this status (403: the org restricts OAuth apps). */
  teamsStatus: number | null = null;
  /** Requests received, `METHOD path`, and the scopes asked at `authorize`. */
  readonly requests: string[] = [];
  private readonly codes = new Map<string, IssuedCode>();
  private readonly tokens = new Map<string, FakeGithubUser>();

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
    base = 'http://github.test',
  ) {
    this.base = new URL(base);
  }

  /** The issuer the gateway records for these users. */
  get issuer(): string {
    return this.base.href.replace(/\/$/, '');
  }

  authorize(url: URL): URL {
    const p = url.searchParams;
    if (`${url.origin}${url.pathname}` !== `${this.issuer}/login/oauth/authorize`) {
      throw new Error(`unexpected authorization endpoint ${url.href}`);
    }
    if (p.get('client_id') !== this.clientId) throw new Error('unknown client_id');
    if (p.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
    const redirectUri = p.get('redirect_uri');
    const state = p.get('state');
    const codeChallenge = p.get('code_challenge');
    if (!redirectUri || !state || !codeChallenge)
      throw new Error('redirect_uri, state and code_challenge required');
    if (!this.nextUser) throw new Error('nobody consents: set nextUser');
    this.requests.push(`authorize scope=${p.get('scope') ?? ''}`);
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, { codeChallenge, redirectUri, user: this.nextUser, consumed: false });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    return callback;
  }

  readonly fetch: CustomFetch = async (url, options) => {
    const target = new URL(url);
    if (target.origin !== this.base.origin) return json({ message: 'wrong host' }, 404);
    const method = options.method ?? 'GET';
    this.requests.push(`${method} ${target.pathname}`);
    if (method === 'POST' && target.pathname === '/login/oauth/access_token') {
      return this.token(new URLSearchParams(String(options.body ?? '')));
    }
    const user = this.tokens.get(
      (new Headers(options.headers).get('authorization') ?? '').replace(/^Bearer\s+/i, ''),
    );
    if (!user) return json({ message: 'Bad credentials' }, 401);
    if (target.pathname === '/api/v3/user') {
      return json({ id: user.id, login: user.login, name: user.name });
    }
    if (target.pathname === '/api/v3/user/emails') return json(user.emails);
    const team = /^\/api\/v3\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/.exec(
      target.pathname,
    );
    if (team) {
      if (this.teamsStatus !== null) return json({ message: 'restricted' }, this.teamsStatus);
      const name = `${decodeURIComponent(team[1] ?? '')}/${decodeURIComponent(team[2] ?? '')}`;
      if (decodeURIComponent(team[3] ?? '') !== user.login)
        return json({ message: 'Not Found' }, 404);
      return (user.teams ?? []).includes(name)
        ? json({ state: 'active', role: 'member' })
        : json({ message: 'Not Found' }, 404);
    }
    return json({ message: 'Not Found' }, 404);
  };

  private token(form: URLSearchParams): Response {
    if (
      form.get('client_id') !== this.clientId ||
      form.get('client_secret') !== this.clientSecret
    ) {
      return json({ error: 'incorrect_client_credentials' });
    }
    const issued = this.codes.get(form.get('code') ?? '');
    if (!issued || issued.consumed) return json({ error: 'bad_verification_code' });
    issued.consumed = true;
    if (form.get('redirect_uri') !== issued.redirectUri)
      return json({ error: 'redirect_uri_mismatch' });
    const challenge = createHash('sha256')
      .update(form.get('code_verifier') ?? '')
      .digest('base64url');
    if (challenge !== issued.codeChallenge) return json({ error: 'bad_verification_code' });
    const token = `gho_${randomBytes(12).toString('hex')}`;
    this.tokens.set(token, issued.user);
    return json({ access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
  }
}

/** One `fetch` for several in-process servers, chosen by origin. */
export function routeFetch(routes: Readonly<Record<string, CustomFetch>>): CustomFetch {
  return async (url, options) => {
    const route = routes[new URL(url).origin];
    if (!route) return json({ error: 'no such host in this test' }, 404);
    return route(url, options);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
