/**
 * An ephemeral instance for the authorization-server tests (spec §10
 * "integration on an ephemeral instance with embedded store and simulated
 * IdP … OAuth delegation"): the real composition root on the `:memory:`
 * store, the in-process `FakeIdp` behind the relying party, and the
 * instance's HTTP surface as one `fetch`-shaped function.
 *
 * `ROUTES` is that surface: each path with the host-agnostic handler its Next
 * route file delegates to. `routes.test.ts` holds the table to the route files
 * on disk, so what a test drives here is what the built application serves.
 */
import type { OAuthClientMetadata } from '@modelcontextprotocol/client';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot, type RootDeps } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import {
  CONSENT_DECISION_PATH,
  CONSENT_FIELD,
  DECISION_FIELD,
  type TokenResponse,
} from '../../../src/server/oauth-as';
import { pkcePair, type PkcePair } from '../../../src/server/oauth-as/testing';
import type { UserRecord } from '../../../src/server/store/types';
import { FakeIdp } from '../auth/fake-idp';

export const PUBLIC_URL = 'https://gateway.example.com';
export const MANAGEMENT_URL = `${PUBLIC_URL}/mcp/manage`;
export const EXECUTION_URL = `${PUBLIC_URL}/mcp`;
export const OPERATOR_EMAIL = 'ops@example.com';
export const LOOPBACK_REDIRECT = 'http://127.0.0.1:43210/callback';
export const WEB_REDIRECT = 'https://agent.example.net/oauth/callback';

const IDP_CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'client-secret-for-tests' };

export const ADA = { sub: 'idp|ada', email: 'ada@example.com', name: 'Ada' } as const;
export const BOB = { sub: 'idp|bob', email: 'bob@example.com', name: 'Bob' } as const;
export const OPS = { sub: 'idp|ops', email: OPERATOR_EMAIL, name: 'Ops' } as const;

type Handler = (root: GatewayRoot, request: Request, id: string) => Promise<Response>;

export interface Route {
  /** The path, `:id` standing for one dynamic segment. */
  readonly path: string;
  /** The route file under `src/app`. */
  readonly file: string;
  /** The handler that file delegates to, as written in it. */
  readonly delegatesTo: string;
  readonly handle: Handler;
}

export const ROUTES: readonly Route[] = [
  {
    path: '/.well-known/oauth-authorization-server',
    file: '.well-known/oauth-authorization-server/route.ts',
    delegatesTo: 'oauth.handlers.authorizationServerMetadata',
    handle: (root, request) => root.oauth.handlers.authorizationServerMetadata(request),
  },
  {
    path: '/.well-known/oauth-protected-resource/mcp/manage',
    file: '.well-known/oauth-protected-resource/mcp/manage/route.ts',
    delegatesTo: 'oauth.handlers.protectedResourceMetadata',
    handle: (root, request) => root.oauth.handlers.protectedResourceMetadata(request),
  },
  {
    path: '/.well-known/oauth-protected-resource',
    file: '.well-known/oauth-protected-resource/route.ts',
    delegatesTo: 'oauth.discovery.executionResource',
    handle: (root, request) => root.oauth.discovery.executionResource(request),
  },
  {
    path: '/oauth/register',
    file: 'oauth/register/route.ts',
    delegatesTo: 'oauth.handlers.register',
    handle: (root, request) => root.oauth.handlers.register(request),
  },
  {
    path: '/oauth/authorize',
    file: 'oauth/authorize/route.ts',
    delegatesTo: 'oauth.handlers.authorize',
    handle: (root, request) => root.oauth.handlers.authorize(request),
  },
  {
    path: CONSENT_DECISION_PATH,
    file: 'oauth/authorize/decision/route.ts',
    delegatesTo: 'oauth.handlers.decide',
    handle: (root, request) => root.oauth.handlers.decide(request),
  },
  {
    path: '/oauth/token',
    file: 'oauth/token/route.ts',
    delegatesTo: 'oauth.handlers.token',
    handle: (root, request) => root.oauth.handlers.token(request),
  },
  {
    path: '/oauth/revoke',
    file: 'oauth/revoke/route.ts',
    delegatesTo: 'oauth.handlers.revoke',
    handle: (root, request) => root.oauth.handlers.revoke(request),
  },
  {
    path: '/mcp/manage',
    file: 'mcp/manage/route.ts',
    delegatesTo: 'management.handlers.mcp',
    handle: (root, request) => root.management.handlers.mcp(request),
  },
  {
    path: '/mcp',
    file: 'mcp/route.ts',
    delegatesTo: 'execution.handlers.mcp',
    handle: (root, request) => root.execution.handlers.mcp(request),
  },
  {
    path: '/auth/login',
    file: 'auth/login/route.ts',
    delegatesTo: 'auth.handlers.loginStart',
    handle: (root, request) => root.auth.handlers.loginStart(request),
  },
  {
    path: '/auth/callback',
    file: 'auth/callback/route.ts',
    delegatesTo: 'auth.handlers.loginCallback',
    handle: (root, request) => root.auth.handlers.loginCallback(request),
  },
  {
    path: '/delegations/:id/revoke',
    file: '(app)/delegations/[id]/revoke/route.ts',
    delegatesTo: 'oauth.handlers.revokeDelegation',
    handle: (root, request, id) => root.oauth.handlers.revokeDelegation(request, id),
  },
  {
    path: '/admin/oauth-clients/:id',
    file: 'admin/(guarded)/oauth-clients/[id]/route.ts',
    delegatesTo: 'oauth.handlers.decideClient',
    handle: (root, request, id) => root.oauth.handlers.decideClient(request, id),
  },
];

function match(route: Route, pathname: string): string | null {
  const pattern = route.path.split('/');
  const actual = pathname.split('/');
  if (pattern.length !== actual.length) return null;
  let id = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === ':id') id = decodeURIComponent(actual[i] ?? '');
    else if (pattern[i] !== actual[i]) return null;
  }
  return id;
}

export interface Instance {
  readonly root: GatewayRoot;
  readonly idp: FakeIdp;
  /** Every log line the instance wrote. */
  readonly logs: string[];
  /** `METHOD /path` of every request the instance served, in order. */
  readonly served: string[];
  /** The instance's HTTP surface. Anything outside it rejects: nothing reaches a network. */
  readonly fetch: typeof fetch;
  browser(): Browser;
  close(): Promise<void>;
}

export interface InstanceOptions {
  readonly env?: Record<string, string | undefined>;
  readonly deps?: RootDeps;
  /** Leave the IdP unconfigured (bootstrap state). */
  readonly withoutIdp?: boolean;
}

export async function openInstance(options: InstanceOptions = {}): Promise<Instance> {
  const logs: string[] = [];
  const served: string[] = [];
  const idp = new FakeIdp(IDP_CLIENT);
  const root = await buildRoot({
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({
          VAUBAAN_PUBLIC_URL: PUBLIC_URL,
          VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
          ...options.env,
        }),
      }),
    logWrite: (_level, line) => logs.push(line),
    oidc: { fetch: idp.fetch, allowInsecureIssuer: true },
    ...memoryStoreDeps,
    ...options.deps,
  });
  if (!options.withoutIdp) {
    await root.auth.idp.save({
      issuer: idp.issuer.href,
      clientId: IDP_CLIENT.clientId,
      clientSecret: IDP_CLIENT.clientSecret,
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
    });
  }

  const dispatch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== PUBLIC_URL) {
      throw new TypeError(`the test instance does not serve ${url.origin}`);
    }
    served.push(`${request.method} ${url.pathname}`);
    for (const route of ROUTES) {
      const id = match(route, url.pathname);
      if (id !== null) return route.handle(root, request, id);
    }
    return new Response('not found', { status: 404 });
  };

  const instance: Instance = {
    root,
    idp,
    logs,
    served,
    fetch: dispatch,
    browser: () => new Browser(instance),
    close: () => root.close(),
  };
  return instance;
}

/**
 * A user's browser: a cookie jar, same-origin form posts, and the walk through
 * the redirects of a sign-in. It never follows a redirect that leaves the
 * instance other than to the simulated IdP: where the instance sends the
 * browser is what the tests assert.
 */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly instance: Instance) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (!name) continue;
      if (attributes.some((a) => a.trim() === 'Max-Age=0') || !value) {
        this.cookies.delete(name.trim());
      } else {
        this.cookies.set(name.trim(), value.trim());
      }
    }
  }

  /** One GET, no redirect followed. */
  async get(pathOrUrl: string): Promise<Response> {
    const response = await this.instance.fetch(new URL(pathOrUrl, PUBLIC_URL), {
      headers: { cookie: this.cookieHeader() },
      redirect: 'manual',
    });
    this.absorb(response);
    return response;
  }

  /** A same-origin form post, as the instance's own pages make them. */
  async post(path: string, fields: Record<string, string>): Promise<Response> {
    const response = await this.instance.fetch(new URL(path, PUBLIC_URL), {
      method: 'POST',
      headers: {
        cookie: this.cookieHeader(),
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    this.absorb(response);
    return response;
  }

  /**
   * GET, then every redirect to an endpoint of the instance or through the IdP
   * (where `claims` consents). Returns the first response that is not such a
   * redirect: a page, or the redirect that leaves the endpoints served here.
   */
  async navigate(pathOrUrl: string, claims: Record<string, unknown> = ADA): Promise<Response> {
    let response = await this.get(pathOrUrl);
    for (let hop = 0; hop < 10; hop += 1) {
      const location = response.headers.get('location');
      if (response.status !== 303 || !location) return response;
      const target = new URL(location, PUBLIC_URL);
      if (target.origin === this.instance.idp.issuer.origin) {
        this.instance.idp.nextClaims = { ...claims };
        response = await this.get(this.instance.idp.authorize(target).href);
      } else if (
        target.origin === PUBLIC_URL &&
        ROUTES.some((route) => match(route, target.pathname) !== null)
      ) {
        response = await this.get(target.href);
      } else {
        // A page of the application (not served here) or the client's redirect URI.
        return response;
      }
    }
    throw new Error('too many redirects');
  }

  /** Signs in through the IdP as `claims` and returns the user row. */
  async signIn(claims: Record<string, unknown> = ADA): Promise<UserRecord> {
    const response = await this.navigate('/auth/login?return_to=/missions', claims);
    if (response.headers.get('location') !== '/missions') {
      throw new Error(`sign-in did not complete: ${response.status}`);
    }
    const sessionId = this.cookies.get(SESSION_COOKIE);
    const principal = await this.instance.root.auth.authenticator.authenticate(
      new Headers({ cookie: `${SESSION_COOKIE}=${sessionId ?? ''}` }),
    );
    if (principal?.kind !== 'user') throw new Error('sign-in produced no user session');
    return principal.user;
  }

  /** A session of the bootstrap operator (no IdP involved). */
  async signInAsBootstrap(): Promise<void> {
    const session = await this.instance.root.auth.sessions.create({ kind: 'bootstrap' });
    this.cookies.set(SESSION_COOKIE, session.id);
  }

  /** Answers the consent screen in `page`; the response is the redirect back to the client. */
  async answerConsent(page: Response, decision: 'approve' | 'deny'): Promise<Response> {
    return this.post(CONSENT_DECISION_PATH, {
      [CONSENT_FIELD]: consentIdOf(await page.text()),
      [DECISION_FIELD]: decision,
    });
  }

  /**
   * The whole human part of an authorization: follow the authorization URL
   * (signing in on the way if needed), read the consent screen, answer it.
   * Returns the URL the browser is finally sent to at the client.
   */
  async authorize(
    authorizationUrl: URL | string,
    options: { claims?: Record<string, unknown>; decision?: 'approve' | 'deny' } = {},
  ): Promise<URL> {
    const page = await this.navigate(String(authorizationUrl), options.claims ?? ADA);
    if (page.status !== 200) {
      throw new Error(`no consent screen: ${page.status} ${await page.text()}`);
    }
    const answered = await this.answerConsent(page, options.decision ?? 'approve');
    const location = answered.headers.get('location');
    if (answered.status !== 303 || !location) {
      throw new Error(`the consent was not answered: ${answered.status} ${await answered.text()}`);
    }
    return new URL(location);
  }
}

/** The id of the pending consent a consent screen posts back. */
export function consentIdOf(html: string): string {
  const id = new RegExp(`name="${CONSENT_FIELD}" value="([^"]+)"`).exec(html)?.[1];
  if (!id) throw new Error('the page is not a consent screen');
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// A plain OAuth client, request by request
// ─────────────────────────────────────────────────────────────────────────────

export const PUBLIC_CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'Scripted MCP client',
  redirect_uris: [LOOPBACK_REDIRECT],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

export interface RegisteredTestClient {
  readonly client_id: string;
  readonly client_secret?: string;
  readonly [field: string]: unknown;
}

export async function register(
  instance: Instance,
  metadata: Record<string, unknown> = PUBLIC_CLIENT_METADATA,
): Promise<RegisteredTestClient> {
  const response = await instance.fetch(`${PUBLIC_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  if (response.status !== 201) {
    throw new Error(`registration refused: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as RegisteredTestClient;
}

/** The authorization URL a client sends the user's browser to. */
export function authorizationUrl(
  clientId: string,
  pkce: PkcePair,
  overrides: Record<string, string | null> = {},
): URL {
  const url = new URL(`${PUBLIC_URL}/oauth/authorize`);
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'mgmt',
    resource: MANAGEMENT_URL,
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

export function tokenRequest(
  instance: Instance,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return instance.fetch(`${PUBLIC_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export interface Delegated {
  readonly clientId: string;
  readonly tokens: TokenResponse;
  readonly user: UserRecord;
  readonly delegationId: string;
}

/**
 * Registration, sign-in, consent and code exchange in one call: a public
 * client holding a delegation of `claims`' user.
 */
export async function delegate(
  instance: Instance,
  claims: Record<string, unknown> = ADA,
  browser: Browser = instance.browser(),
): Promise<Delegated> {
  const client = await register(instance);
  const pkce = pkcePair();
  const callback = await browser.authorize(authorizationUrl(client.client_id, pkce), { claims });
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(`no code in ${callback.href}`);
  const response = await tokenRequest(instance, {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    code_verifier: pkce.verifier,
    redirect_uri: LOOPBACK_REDIRECT,
  });
  if (response.status !== 200) throw new Error(`token refused: ${await response.text()}`);
  const tokens = (await response.json()) as TokenResponse;
  const delegation = await instance.root.oauth.verifier.resolve(tokens.access_token);
  if (!delegation) throw new Error('the access token does not resolve');
  const user = await instance.root.store.users.getById(delegation.user_id);
  if (!user) throw new Error('the delegating user does not exist');
  return { clientId: client.client_id, tokens, user, delegationId: delegation.delegation_id };
}

/** A JSON-RPC `tools/list` at an MCP door, with whatever credentials are given. */
export function toolsList(
  instance: Instance,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return instance.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
