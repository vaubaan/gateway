/**
 * Human authentication end to end inside the process (spec §10 "integration
 * on an ephemeral instance with embedded store and simulated IdP"): the
 * composition root over the `:memory:` store, the real relying party
 * (`openid-client`) talking to the in-process `FakeIdp` through `customFetch`,
 * the host-agnostic handlers driven with web-standard `Request`s.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_ACTOR_ID } from '@vaubaan/gateway-core';

import { BOOTSTRAP_REVOKED_KEY, IDP_CONFIG_KEYS, SESSION_COOKIE } from '../../../src/server/auth';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { TEST_BOOTSTRAP_TOKEN, validEnv } from '../../../src/server/config/testing';
import { FakeIdp } from './fake-idp';

const PUBLIC_URL = 'https://gateway.example.com';
const ADMIN_GROUP = 'gateway-admins';
const CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'client-secret-for-tests' };

interface Browser {
  cookies: Map<string, string>;
}

function cookieHeader(b: Browser): string {
  return [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(b: Browser, res: Response): void {
  for (const header of res.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (!name) continue;
    if (attrs.some((a) => a.trim() === 'Max-Age=0') || !value) b.cookies.delete(name.trim());
    else b.cookies.set(name.trim(), value.trim());
  }
}

describe('OIDC login, web session, bootstrap token and admin rule', () => {
  let root: GatewayRoot;
  let idp: FakeIdp;
  let lines: string[];

  beforeEach(async () => {
    lines = [];
    idp = new FakeIdp(CLIENT);
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_GROUP: ADMIN_GROUP,
            VAUBAAN_ADMIN_EMAILS: 'ops@example.com',
          }),
        }),
      logWrite: (_lvl, line) => lines.push(line),
      oidc: { fetch: idp.fetch, allowInsecureIssuer: true },
      ...memoryStoreDeps,
    });
  });
  afterEach(async () => {
    await root.close();
  });

  async function configureIdp(): Promise<void> {
    await root.auth.idp.save({
      issuer: idp.issuer.href,
      clientId: CLIENT.clientId,
      clientSecret: CLIENT.clientSecret,
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
    });
  }

  /** The browser's round trip: /auth/login → IdP consent → /auth/callback. */
  async function signIn(
    b: Browser,
    claims: Record<string, unknown>,
    options: { returnTo?: string; callbackHost?: string; tamper?: (cb: URL) => void } = {},
  ): Promise<Response> {
    idp.nextClaims = claims;
    const returnTo = options.returnTo ?? '/admin';
    const start = await root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login?return_to=${encodeURIComponent(returnTo)}`),
    );
    expect(start.status).toBe(303);
    absorbCookies(b, start);
    const location = start.headers.get('location');
    if (!location || location.startsWith('/login')) return start;
    const callback = idp.authorize(new URL(location));
    options.tamper?.(callback);
    // What the process sees may be the internal host behind the TLS terminator.
    const seen = new URL(callback.href);
    if (options.callbackHost) {
      seen.protocol = 'http:';
      seen.host = options.callbackHost;
    }
    const finish = await root.auth.handlers.loginCallback(
      new Request(seen.href, { headers: { cookie: cookieHeader(b) } }),
    );
    absorbCookies(b, finish);
    return finish;
  }

  function headersOf(b: Browser, extra: Record<string, string> = {}): Headers {
    return new Headers({ cookie: cookieHeader(b), ...extra });
  }

  it('creates the user and its IdP groups on first sign-in; the operator marker follows the admin rule', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    const res = await signIn(b, {
      sub: 'idp|ada',
      email: 'Ada@Example.com',
      name: 'Ada',
      groups: ['dev', ADMIN_GROUP],
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
    expect(b.cookies.has('vbn_login')).toBe(false);
    expect(res.headers.getSetCookie().join('\n')).toMatch(
      /vbn_session=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/,
    );

    const user = await root.store.users.getBySubject('idp|ada');
    expect(user).toMatchObject({ email: 'ada@example.com', displayName: 'Ada', status: 'active' });
    const groups = await root.store.groups.groupsOf(user!.id);
    expect(groups.map((g) => [g.name, g.source])).toEqual([
      ['dev', 'idp'],
      [ADMIN_GROUP, 'idp'],
    ]);

    const principal = await root.auth.authenticator.authenticate(headersOf(b));
    expect(principal).toMatchObject({
      kind: 'user',
      isOperator: true,
      login: { email: 'ada@example.com' },
    });
    expect(await root.auth.authenticator.authorizeAdmin(principal)).toMatchObject({ ok: true });
    expect(idp.requests.join('\n')).toContain('authorize scope=openid profile email groups');
    expect(lines.join('\n')).not.toContain(CLIENT.clientSecret);
  });

  it('rewrites IdP-sourced memberships on re-login and leaves local groups alone', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|bob', email: 'bob@example.com', groups: ['dev', 'ops'] });
    const bob = (await root.store.users.getBySubject('idp|bob'))!;
    const local = await root.store.groups.getOrCreate('local-reviewers', 'local');
    await root.store.groups.addMember(local.id, bob.id);

    const b2: Browser = { cookies: new Map() };
    await signIn(b2, { sub: 'idp|bob', email: 'bob@example.com', groups: 'ops security' });
    const names = (await root.store.groups.groupsOf(bob.id)).map((g) => g.name).sort();
    expect(names).toEqual(['local-reviewers', 'ops', 'security']);
    // the emptied idp group survives as a row (it may own connections); membership is what moves
    expect(await root.store.groups.getByName('dev')).not.toBeNull();
    expect(
      await root.store.groups.memberCount((await root.store.groups.getByName('dev'))!.id),
    ).toBe(0);
  });

  it('ignores a claim that collides with a local group instead of granting it', async () => {
    await configureIdp();
    await root.store.groups.getOrCreate('finance', 'local');
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|eve', email: 'eve@example.com', groups: ['finance'] });
    const eve = (await root.store.users.getBySubject('idp|eve'))!;
    expect(await root.store.groups.groupsOf(eve.id)).toEqual([]);
    expect(lines.join('\n')).toContain('collides with a local group');
  });

  it('structural: authority is recomputed from current membership — removed from the admin group, the next check fails', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|cat', email: 'cat@example.com', groups: [ADMIN_GROUP] });
    const first = await root.auth.authenticator.authenticate(headersOf(b));
    expect(first).toMatchObject({ kind: 'user', isOperator: true });

    const admins = (await root.store.groups.getByName(ADMIN_GROUP))!;
    const cat = (await root.store.users.getBySubject('idp|cat'))!;
    await root.store.groups.removeMember(admins.id, cat.id);

    const second = await root.auth.authenticator.authenticate(headersOf(b));
    expect(second).toMatchObject({ kind: 'user', isOperator: false });
    expect(await root.auth.authenticator.authorizeAdmin(second)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('non-admin user: 403 on the admin surface, pages and mutations alike', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|dan', email: 'dan@example.com', groups: ['dev'] });
    const principal = await root.auth.authenticator.authenticate(headersOf(b));
    expect(principal).toMatchObject({ kind: 'user', isOperator: false });
    expect(await root.auth.authenticator.authorizeAdmin(principal)).toEqual({
      ok: false,
      status: 403,
      reason: 'user does not match the admin rule',
    });
    const form = new URLSearchParams({
      issuer: 'https://x.test',
      client_id: 'c',
      client_secret: 's',
      claim_sub: 'sub',
      claim_email: 'email',
      claim_groups: 'groups',
      allowed_email_domains: '',
    });
    const res = await root.auth.handlers.saveIdpSettings(
      new Request(`${PUBLIC_URL}/api/admin/identity-provider`, {
        method: 'POST',
        headers: headersOf(b, {
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        }),
        body: form.toString(),
      }),
    );
    expect(res.status).toBe(403);
    expect(await root.auth.authenticator.authorizeAdmin(null)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('bootstrap: the token opens /admin while no IdP is configured, is revoked by the first operator sign-in, then refused', async () => {
    const b: Browser = { cookies: new Map() };
    const post = (token: string, origin: string | null = PUBLIC_URL) =>
      root.auth.handlers.bootstrapLogin(
        new Request(`${PUBLIC_URL}/api/auth/bootstrap`, {
          method: 'POST',
          headers: {
            cookie: cookieHeader(b),
            'content-type': 'application/x-www-form-urlencoded',
            ...(origin ? { origin } : {}),
          },
          body: new URLSearchParams({ token }).toString(),
        }),
      );

    // no IdP yet: /auth/login has nothing to redirect to
    const noIdp = await root.auth.handlers.loginStart(new Request(`${PUBLIC_URL}/auth/login`));
    expect(noIdp.headers.get('location')).toBe('/login?error=idp-not-configured');

    expect((await post(TEST_BOOTSTRAP_TOKEN, null)).status).toBe(403); // origin check
    const wrong = await post('not-the-token-at-all-but-long-enough-to-try');
    expect(wrong.headers.get('location')).toBe('/admin/bootstrap?error=bootstrap-refused');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);

    const ok = await post(TEST_BOOTSTRAP_TOKEN);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/admin');
    absorbCookies(b, ok);
    const bootstrapPrincipal = await root.auth.authenticator.authenticate(headersOf(b));
    expect(bootstrapPrincipal).toMatchObject({ kind: 'bootstrap' });
    expect(await root.auth.authenticator.authorizeAdmin(bootstrapPrincipal)).toMatchObject({
      ok: true,
    });

    // the bootstrap operator configures the IdP through the form (secret sealed, audited)
    const form = new URLSearchParams({
      issuer: idp.issuer.href,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      claim_sub: 'sub',
      claim_email: 'email',
      claim_groups: 'groups',
      allowed_email_domains: 'example.com',
    });
    const saved = await root.auth.handlers.saveIdpSettings(
      new Request(`${PUBLIC_URL}/api/admin/identity-provider`, {
        method: 'POST',
        headers: headersOf(b, {
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        }),
        body: form.toString(),
      }),
    );
    expect(saved.headers.get('location')).toBe('/admin/identity-provider?saved=1');
    expect(await root.store.config.getSecret(IDP_CONFIG_KEYS.clientSecret)).toBe(
      CLIENT.clientSecret,
    );
    const audit = await root.store.audit.list({ kind: 'admin' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'admin',
      user_id: BOOTSTRAP_ACTOR_ID,
      act: 'config-changed',
      object: { type: 'instance-config', id: 'idp' },
    });
    expect(JSON.stringify(audit[0])).not.toContain(CLIENT.clientSecret);

    // a non-operator IdP sign-in does not revoke the token
    const dev: Browser = { cookies: new Map() };
    await signIn(dev, { sub: 'idp|dev', email: 'dev@example.com', groups: ['dev'] });
    expect(await root.auth.bootstrap.state()).toEqual({ status: 'active' });

    // the first operator sign-in does
    const ops: Browser = { cookies: new Map() };
    await signIn(ops, { sub: 'idp|ops', email: 'ops@example.com', groups: [] });
    expect(await root.auth.bootstrap.state()).toMatchObject({ status: 'revoked' });
    expect(await root.store.config.get(BOOTSTRAP_REVOKED_KEY)).toMatch(/^\d{4}-/);
    expect(lines.join('\n')).toContain('bootstrap token revoked');

    // refused from now on: new attempts and the existing bootstrap session alike
    const late = await post(TEST_BOOTSTRAP_TOKEN);
    expect(late.headers.get('location')).toBe('/admin/bootstrap?error=bootstrap-unavailable');
    expect(await root.auth.bootstrap.verify(TEST_BOOTSTRAP_TOKEN)).toBe(false);
    // …on every surface, not only /admin: the session stops being a principal
    // (the Audit page and the shell call `authenticate()` alone).
    const stale = await root.auth.authenticator.authenticate(headersOf(b));
    expect(stale).toBeNull();
    expect(await root.auth.authenticator.authorizeAdmin(stale)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await root.auth.authenticator.authenticate(headersOf(b))).toBeNull();
  });

  it('builds the callback URL from public_url, not from the host the process sees', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    const res = await signIn(
      b,
      { sub: 'idp|fay', email: 'fay@example.com' },
      { callbackHost: '127.0.0.1:3000', returnTo: '/login' },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
  });

  it('refuses a tampered state, an expired attempt and an IdP error with closed codes', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    const tampered = await signIn(
      b,
      { sub: 'idp|x', email: 'x@example.com' },
      { tamper: (cb) => cb.searchParams.set('state', 'forged') },
    );
    expect(tampered.headers.get('location')).toBe('/login?error=state-mismatch');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(b.cookies.has('vbn_login')).toBe(false);

    const expired = await root.auth.handlers.loginCallback(
      new Request(`${PUBLIC_URL}/auth/callback?code=c&state=s`),
    );
    expect(expired.headers.get('location')).toBe('/login?error=login-expired');

    idp.nextError = 'access_denied';
    const refused = await signIn(b, { sub: 'idp|x', email: 'x@example.com' });
    expect(refused.headers.get('location')).toBe('/login?error=idp-error');
    expect(lines.join('\n')).toContain('access_denied');
  });

  it('refuses an email outside the allowed domains and missing claims', async () => {
    await root.auth.idp.save({
      issuer: idp.issuer.href,
      clientId: CLIENT.clientId,
      clientSecret: CLIENT.clientSecret,
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: ['example.com'],
    });
    const b: Browser = { cookies: new Map() };
    const outside = await signIn(b, { sub: 'idp|o', email: 'o@elsewhere.test' });
    expect(outside.headers.get('location')).toBe('/login?error=email-domain-not-allowed');
    expect(await root.store.users.getBySubject('idp|o')).toBeNull();
    const noEmail = await signIn(b, { sub: 'idp|n' });
    expect(noEmail.headers.get('location')).toBe('/login?error=claims-missing');
  });

  it('merges userinfo claims under the ID token claims', async () => {
    const withUserinfo = new FakeIdp({ ...CLIENT, userinfoOnly: ['groups', 'email'] });
    await root.close();
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_GROUP: ADMIN_GROUP }),
        }),
      logWrite: () => undefined,
      oidc: { fetch: withUserinfo.fetch, allowInsecureIssuer: true },
      ...memoryStoreDeps,
    });
    idp = withUserinfo;
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|ui', email: 'ui@example.com', groups: [ADMIN_GROUP] });
    const ui = (await root.store.users.getBySubject('idp|ui'))!;
    expect(ui.email).toBe('ui@example.com');
    expect((await root.store.groups.groupsOf(ui.id)).map((g) => g.name)).toEqual([ADMIN_GROUP]);
    expect(withUserinfo.requests).toContain('GET /userinfo');
  });

  it('logout requires the origin check, then destroys the server-side session', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|gil', email: 'gil@example.com' });
    const crossSite = await root.auth.handlers.logout(
      new Request(`${PUBLIC_URL}/logout`, {
        method: 'POST',
        headers: headersOf(b, { origin: 'https://evil.example.net' }),
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(await root.auth.authenticator.authenticate(headersOf(b))).not.toBeNull();

    const sameSite = await root.auth.handlers.logout(
      new Request(`${PUBLIC_URL}/logout`, {
        method: 'POST',
        headers: headersOf(b, { origin: PUBLIC_URL }),
      }),
    );
    expect(sameSite.status).toBe(303);
    expect(sameSite.headers.get('location')).toBe('/login');
    const stale = new Headers({ cookie: cookieHeader(b) }); // the browser kept the old cookie
    expect(await root.auth.authenticator.authenticate(stale)).toBeNull();
    absorbCookies(b, sameSite);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it('sessions live in the embedded store (web_sessions), not in process memory', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|hal', email: 'hal@example.com' });
    const n = root.store.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM web_sessions')
      .get()?.n;
    expect(n).toBe(1);
  });
});
