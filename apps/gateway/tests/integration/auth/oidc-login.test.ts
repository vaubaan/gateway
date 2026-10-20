/**
 * Human authentication end to end inside the process (spec §10 "integration
 * on an ephemeral instance with embedded store and simulated IdP"): the
 * composition root over the `:memory:` store, the real relying party
 * (`openid-client`) talking to the in-process `FakeIdp` through `customFetch`,
 * the host-agnostic handlers driven with web-standard `Request`s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_ACTOR_ID } from '@vaubaan/gateway-core';

import {
  BOOTSTRAP_REVOKED_KEY,
  IDP_CONFIG_KEYS,
  LOGIN_COOKIE,
  SESSION_COOKIE,
} from '../../../src/server/auth';
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
    expect(b.cookies.has(LOGIN_COOKIE)).toBe(false);
    expect(res.headers.getSetCookie().join('\n')).toMatch(
      /^__Host-vbn_session=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/,
    );

    const user = await root.store.users.getByIdentity(idp.iss, 'idp|ada');
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
    const bob = (await root.store.users.getByIdentity(idp.iss, 'idp|bob'))!;
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
    const eve = (await root.store.users.getByIdentity(idp.iss, 'idp|eve'))!;
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
    const cat = (await root.store.users.getByIdentity(idp.iss, 'idp|cat'))!;
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
      reason: 'user is not an administrator of this instance',
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
    expect(saved.headers.get('location')).toBe('/admin/identity-provider?saved=idp');
    expect(await root.store.config.getSecret(IDP_CONFIG_KEYS.clientSecret)).toBe(
      CLIENT.clientSecret,
    );
    const audit = (await root.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.act !== 'administrators-seeded',
    );
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
    expect(b.cookies.has(LOGIN_COOKIE)).toBe(false);

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
    expect(await root.store.users.getByIdentity(idp.iss, 'idp|o')).toBeNull();
    const noEmail = await signIn(b, { sub: 'idp|n' });
    expect(noEmail.headers.get('location')).toBe('/login?error=claims-missing');
  });

  it('refuses a sign-in whose email the IdP marks as unverified: no user, no operator, token still active', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    // `ops@example.com` is on the admin list: an unverified claim must not make an operator.
    const res = await signIn(b, {
      sub: 'idp|mallory',
      email: 'ops@example.com',
      email_verified: false,
    });
    expect(res.headers.get('location')).toBe('/login?error=email-not-verified');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await root.store.users.getByIdentity(idp.iss, 'idp|mallory')).toBeNull();
    expect(await root.auth.bootstrap.state()).toEqual({ status: 'active' });

    const verified = await signIn(b, {
      sub: 'idp|ops',
      email: 'ops@example.com',
      email_verified: true,
    });
    expect(verified.headers.get('location')).toBe('/admin');
  });

  it('refuses a sign-in whose groups the IdP moved out of the token (Entra ID overage): memberships are kept, not emptied', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|ada', email: 'ada@example.com', groups: ['team-a', ADMIN_GROUP] });
    const ada = await root.store.users.getByIdentity(idp.iss, 'idp|ada');
    expect(ada).not.toBeNull();
    if (!ada) return;
    const before = (await root.store.groups.groupsOf(ada.id)).map((g) => g.name).sort();
    expect(before).toEqual([ADMIN_GROUP, 'team-a'].sort());

    // Ada joined her 201st group: the token carries a pointer instead of the list.
    const second: Browser = { cookies: new Map() };
    const res = await signIn(second, {
      sub: 'idp|ada',
      email: 'ada@example.com',
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.example/getMemberObjects' } },
    });
    expect(res.headers.get('location')).toBe('/login?error=groups-overage');
    expect(second.cookies.has(SESSION_COOKIE)).toBe(false);
    // Nothing was synced: reading the pointer as "no groups" would have emptied these.
    expect((await root.store.groups.groupsOf(ada.id)).map((g) => g.name).sort()).toEqual(before);
    // The first session still stands, operator marker included.
    const principal = await root.auth.authenticator.authenticate(headersOf(b));
    expect(principal?.kind === 'user' && principal.isOperator).toBe(true);
    // The operator finds the cause and the remedy in the log.
    const logged = lines.find((line) => line.includes('groups-overage'));
    expect(logged).toBeDefined();
    expect(logged).toMatch(/Groups assigned to the application/);

    // A user never seen before is not created either.
    const res2 = await signIn(
      { cookies: new Map() },
      {
        sub: 'idp|grace',
        email: 'grace@example.com',
        hasgroups: true,
      },
    );
    expect(res2.headers.get('location')).toBe('/login?error=groups-overage');
    expect(await root.store.users.getByIdentity(idp.iss, 'idp|grace')).toBeNull();
  });

  it('a sign-in replaces the session the browser already had', async () => {
    await configureIdp();
    const b: Browser = { cookies: new Map() };
    await signIn(b, { sub: 'idp|ada', email: 'ada@example.com' });
    const first = headersOf(b);
    expect(await root.auth.authenticator.authenticate(first)).not.toBeNull();
    await signIn(b, { sub: 'idp|ada', email: 'ada@example.com' });
    expect(await root.auth.authenticator.authenticate(first)).toBeNull();
    expect(await root.auth.authenticator.authenticate(headersOf(b))).not.toBeNull();
  });

  it('an IdP save whose audit entry cannot be written is reported at error, not lost in silence', async () => {
    const b: Browser = { cookies: new Map() };
    const login = await root.auth.handlers.bootstrapLogin(
      new Request(`${PUBLIC_URL}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { origin: PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_BOOTSTRAP_TOKEN }).toString(),
      }),
    );
    absorbCookies(b, login);
    vi.spyOn(root.store.auditWriter, 'write').mockRejectedValueOnce(new Error('audit down'));
    const saved = await root.auth.handlers.saveIdpSettings(
      new Request(`${PUBLIC_URL}/api/admin/identity-provider`, {
        method: 'POST',
        headers: headersOf(b, {
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        }),
        body: new URLSearchParams({
          issuer: idp.issuer.href,
          client_id: CLIENT.clientId,
          client_secret: CLIENT.clientSecret,
          claim_sub: 'sub',
          claim_email: 'email',
          claim_groups: 'groups',
          allowed_email_domains: '',
        }).toString(),
      }),
    );
    vi.restoreAllMocks();
    // The settings are stored (one transaction); the missing entry is an error line naming the actor.
    expect(saved.headers.get('location')).toBe('/admin/identity-provider?saved=idp');
    expect((await root.auth.idp.current())?.settings.clientId).toBe(CLIENT.clientId);
    const errorLine = lines.find((l) => l.includes('audit entry not written'));
    expect(errorLine).toBeDefined();
    expect(JSON.parse(errorLine ?? '{}')).toMatchObject({
      level: 'error',
      actor: BOOTSTRAP_ACTOR_ID,
      object: 'idp',
    });
    expect(errorLine).not.toContain(CLIENT.clientSecret);
  });

  it('answers 400 to a body that is not a form instead of failing', async () => {
    const notAForm = (path: string) =>
      new Request(`${PUBLIC_URL}${path}`, {
        method: 'POST',
        headers: { origin: PUBLIC_URL, 'content-type': 'application/json' },
        body: '{"token":"x"}',
      });
    expect((await root.auth.handlers.bootstrapLogin(notAForm('/api/auth/bootstrap'))).status).toBe(
      400,
    );
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
    const ui = (await root.store.users.getByIdentity(idp.iss, 'idp|ui'))!;
    expect(ui.email).toBe('ui@example.com');
    expect((await root.store.groups.groupsOf(ui.id)).map((g) => g.name)).toEqual([ADMIN_GROUP]);
    expect(withUserinfo.requests).toContain('GET /userinfo');
  });

  it('refuses the sign-in when the groups come from userinfo and userinfo is down: unknown groups are not "no groups"', async () => {
    const groupsFromUserinfo = new FakeIdp({ ...CLIENT, userinfoOnly: ['groups'] });
    await root.close();
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_GROUP: ADMIN_GROUP }),
        }),
      logWrite: (_lvl, line) => lines.push(line),
      oidc: { fetch: groupsFromUserinfo.fetch, allowInsecureIssuer: true },
      ...memoryStoreDeps,
    });
    idp = groupsFromUserinfo;
    await configureIdp();
    const claims = { sub: 'idp|ada', email: 'ada@example.com', groups: ['dev', ADMIN_GROUP] };
    const first: Browser = { cookies: new Map() };
    expect((await signIn(first, claims)).headers.get('location')).toBe('/admin');
    const ada = (await root.store.users.getByIdentity(idp.iss, 'idp|ada'))!;
    const groupsOf = async (): Promise<string[]> =>
      (await root.store.groups.groupsOf(ada.id)).map((g) => g.name).sort();
    const before = await groupsOf();
    expect(before).toEqual(['dev', ADMIN_GROUP].sort());

    idp.userinfoDown = true;
    const second: Browser = { cookies: new Map() };
    const refused = await signIn(second, claims);

    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toBe('/login?error=groups-unavailable');
    expect(second.cookies.has(SESSION_COOKIE)).toBe(false);
    // Nothing was synced: an empty list would have taken Ada out of both groups.
    expect(await groupsOf()).toEqual(before);
    // The session she already had keeps its operator marker.
    const principal = await root.auth.authenticator.authenticate(headersOf(first));
    expect(principal?.kind === 'user' && principal.isOperator).toBe(true);
    expect(lines.some((line) => line.includes('groups-unavailable'))).toBe(true);
    // Somebody never seen before is not created without their groups either.
    const stranger = await signIn(
      { cookies: new Map() },
      { sub: 'idp|new', email: 'new@example.com', groups: ['dev'] },
    );
    expect(stranger.headers.get('location')).toBe('/login?error=groups-unavailable');
    expect(await root.store.users.getByIdentity(idp.iss, 'idp|new')).toBeNull();

    idp.userinfoDown = false;
    expect((await signIn({ cookies: new Map() }, claims)).headers.get('location')).toBe('/admin');
  });

  it('userinfo down does not refuse a sign-in whose ID token carries the groups', async () => {
    await configureIdp();
    idp.userinfoDown = true;
    const b: Browser = { cookies: new Map() };
    const res = await signIn(b, { sub: 'idp|ada', email: 'ada@example.com', groups: ['dev'] });
    expect(res.headers.get('location')).toBe('/admin');
    const ada = (await root.store.users.getByIdentity(idp.iss, 'idp|ada'))!;
    expect((await root.store.groups.groupsOf(ada.id)).map((g) => g.name)).toEqual(['dev']);
    expect(lines.some((line) => line.includes('userinfo request failed'))).toBe(true);
  });

  describe('a user is (issuer, subject)', () => {
    const OTHER_ISSUER = 'http://other-idp.test';
    let other: FakeIdp;

    beforeEach(async () => {
      other = new FakeIdp({ ...CLIENT, issuer: OTHER_ISSUER });
      const first = idp;
      await root.close();
      root = await buildRoot({
        loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL }) }),
        logWrite: (_lvl, line) => lines.push(line),
        oidc: {
          // Both identity providers are reachable; the instance talks to the configured one.
          fetch: (url, options) =>
            new URL(url).origin === other.issuer.origin
              ? other.fetch(url, options)
              : first.fetch(url, options),
          allowInsecureIssuer: true,
        },
        ...memoryStoreDeps,
      });
    });

    it('after the operator points the instance at another IdP, the same subject is a new person', async () => {
      await configureIdp();
      const adaBrowser: Browser = { cookies: new Map() };
      await signIn(adaBrowser, { sub: '1042', email: 'ada@example.com', groups: ['owners'] });
      const ada = (await root.store.users.getByIdentity(idp.iss, '1042'))!;
      const firstIdp = idp;

      // The new provider numbers its users from 1000 too.
      idp = other;
      await configureIdp();
      const eveBrowser: Browser = { cookies: new Map() };
      const res = await signIn(eveBrowser, { sub: '1042', email: 'eve@example.com' });
      expect(res.headers.get('location')).toBe('/admin');

      const eve = (await root.store.users.getByIdentity(other.iss, '1042'))!;
      expect(eve.id).not.toBe(ada.id);
      expect(eve).toMatchObject({ issuer: OTHER_ISSUER, email: 'eve@example.com' });
      // Ada's account is as she left it: not refreshed, not signed into, groups intact.
      expect(await root.store.users.getById(ada.id)).toMatchObject({
        issuer: firstIdp.iss,
        email: 'ada@example.com',
        lastLoginAt: ada.lastLoginAt,
      });
      expect((await root.store.groups.groupsOf(ada.id)).map((g) => g.name)).toEqual(['owners']);
      expect(await root.store.groups.groupsOf(eve.id)).toEqual([]);
      const principal = await root.auth.authenticator.authenticate(headersOf(eveBrowser));
      expect(principal?.kind === 'user' && principal.user.id).toBe(eve.id);
      expect(await root.store.users.list()).toHaveLength(2);
    });

    it('an account deactivated here stays closed to its issuer, and does not close the same subject elsewhere', async () => {
      await configureIdp();
      await signIn({ cookies: new Map() }, { sub: '7', email: 'ada@example.com' });
      const ada = (await root.store.users.getByIdentity(idp.iss, '7'))!;
      await root.store.users.markRemoved(ada.id);
      const again = await signIn({ cookies: new Map() }, { sub: '7', email: 'ada@example.com' });
      expect(again.headers.get('location')).toBe('/login?error=account-deactivated');

      idp = other;
      await configureIdp();
      const res = await signIn({ cookies: new Map() }, { sub: '7', email: 'zoe@example.com' });
      expect(res.headers.get('location')).toBe('/admin');
      expect((await root.store.users.getById(ada.id))?.status).toBe('removed');
    });

    it('accounts from before the issuer was recorded are bound by the first sign-in, all of them, once', async () => {
      await configureIdp();
      // Two accounts as migration 0011 leaves them: Ada, and Bob whom an operator deactivated.
      const legacy = root.store.db.prepare(
        `INSERT INTO users (id, identity_key, issuer, subject, email, status, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
      );
      legacy.run('usr_ada', 'unbound idp|ada', 'idp|ada', 'ada@example.com', 'active');
      legacy.run('usr_bob', 'unbound idp|bob', 'idp|bob', 'bob@example.com', 'removed');

      const b: Browser = { cookies: new Map() };
      const res = await signIn(b, { sub: 'idp|ada', email: 'ada@example.com' });
      expect(res.headers.get('location')).toBe('/admin');

      // Ada is back in her own account, not a new one.
      const principal = await root.auth.authenticator.authenticate(headersOf(b));
      expect(principal?.kind === 'user' && principal.user.id).toBe('usr_ada');
      expect(await root.store.users.list()).toHaveLength(2);
      expect(lines.some((line) => line.includes('existing accounts bound'))).toBe(true);
      // Bob did not sign in and is bound too: his deactivation still holds at this issuer…
      const bob = await signIn(
        { cookies: new Map() },
        { sub: 'idp|bob', email: 'bob@example.com' },
      );
      expect(bob.headers.get('location')).toBe('/login?error=account-deactivated');

      // …and nothing is left for another issuer to take.
      idp = other;
      await configureIdp();
      await signIn({ cookies: new Map() }, { sub: 'idp|ada', email: 'mallory@example.com' });
      const mallory = (await root.store.users.getByIdentity(other.iss, 'idp|ada'))!;
      expect(mallory.id).not.toBe('usr_ada');
      expect((await root.store.users.getById('usr_ada'))?.email).toBe('ada@example.com');
    });
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
    expect(await root.store.webSessions.count()).toBe(1);
    // Keyed by a digest: the cookie value is not in the table.
    const dump = root.store.db
      .prepare<[], { id: string }>('SELECT id FROM web_sessions')
      .all()
      .map((r) => r.id);
    expect(dump).toHaveLength(1);
    expect(dump.join()).not.toContain(b.cookies.get(SESSION_COOKIE));
    expect(dump[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
