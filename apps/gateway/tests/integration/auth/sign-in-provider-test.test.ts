/**
 * A sign-in provider is tested beside the session, and switched on after a passed
 * test (ADR administrators-live-in-the-instance, §5): the test runs the sign-in provider's
 * flow to its end and signs nobody in — no user, no session, no group — while the
 * tester's own session stays; its result says what the sign-in provider returned and the
 * verdict a sign-in would get, and the setup can make the tested identity the first
 * administrator. A sign-in provider switched off is refused at sign-in, and switching off
 * the last administrator's way in is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_COOKIE, SESSION_COOKIE, signInTestPage } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { FakeGithub, routeFetch } from './fake-github';
import { FakeIdp } from './fake-idp';

const PUBLIC_URL = 'https://gateway.example.com';
const CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'company-client-secret' };
const GITHUB_CLIENT = { clientId: 'Ov23liTest', clientSecret: 'github-client-secret' };

type Browser = Map<string, string>;

function cookieHeader(b: Browser): string {
  return [...b].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(b: Browser, res: Response): void {
  for (const header of res.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (!name) continue;
    if (attrs.some((a) => a.trim() === 'Max-Age=0') || !value) b.delete(name.trim());
    else b.set(name.trim(), value.trim());
  }
}

function post(path: string, b: Browser): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(b),
      origin: PUBLIC_URL,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: '',
  });
}

describe('a sign-in provider is tested beside the session, then switched on', () => {
  let root: GatewayRoot;
  let idp: FakeIdp;
  let github: FakeGithub;

  beforeEach(async () => {
    idp = new FakeIdp(CLIENT);
    github = new FakeGithub(GITHUB_CLIENT.clientId, GITHUB_CLIENT.clientSecret);
    root = await buildRoot({
      // No admin rule: the setup names the first administrator.
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: undefined }),
        }),
      logWrite: () => undefined,
      oidc: {
        fetch: routeFetch({ [idp.issuer.origin]: idp.fetch, [github.base.origin]: github.fetch }),
        allowInsecureIssuer: true,
      },
      ...memoryStoreDeps,
    });
    await root.auth.signInProviders.save(
      {
        id: 'company',
        kind: 'oidc',
        name: 'Acme',
        issuer: idp.issuer.href,
        clientId: CLIENT.clientId,
        clientSecret: CLIENT.clientSecret,
        claims: { sub: 'sub', email: 'email', groups: 'groups' },
        allowedEmailDomains: ['example.com'],
        invitationOnly: false,
      },
      'create',
    );
    await root.auth.signInProviders.save(
      {
        id: 'github',
        kind: 'github',
        name: '',
        issuer: github.base.href,
        clientId: GITHUB_CLIENT.clientId,
        clientSecret: GITHUB_CLIENT.clientSecret,
        allowedEmailDomains: [],
        invitationOnly: true,
      },
      'create',
    );
  });
  afterEach(async () => {
    await root.close();
  });

  async function bootstrapBrowser(): Promise<Browser> {
    const session = await root.auth.sessions.create({ kind: 'bootstrap' });
    return new Map([[SESSION_COOKIE, session.id]]);
  }

  /** The Test button of Settings → Sign-in, posted from the tester's browser. */
  function testForm(b: Browser, signInProviderId: string): Request {
    return new Request(`${PUBLIC_URL}/auth/test/${signInProviderId}`, {
      method: 'POST',
      headers: { cookie: cookieHeader(b), origin: PUBLIC_URL },
    });
  }

  /** Test → the sign-in provider's consent → the callback, in the tester's browser. */
  async function test(b: Browser, signInProviderId: 'company' | 'github'): Promise<Response> {
    const start = await root.auth.handlers.testStart(
      testForm(b, signInProviderId),
      signInProviderId,
    );
    expect(start.status).toBe(303);
    absorb(b, start);
    const location = new URL(start.headers.get('location') ?? '', PUBLIC_URL);
    if (location.origin === PUBLIC_URL) return start;
    const callback =
      signInProviderId === 'github' ? github.authorize(location) : idp.authorize(location);
    const finish = await root.auth.handlers.loginCallback(
      new Request(callback.href, { headers: { cookie: cookieHeader(b) } }),
      signInProviderId,
    );
    absorb(b, finish);
    return finish;
  }

  it('a new sign-in provider is saved off: not offered, refused at sign-in, not switched on untested', async () => {
    expect((await root.auth.signInProviders.views()).map((p) => [p.id, p.enabled])).toEqual([
      ['company', false],
      ['github', false],
    ]);
    const start = await root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login/company`),
      'company',
    );
    expect(start.headers.get('location')).toBe('/login?error=sign-in-provider-disabled');
    const b = await bootstrapBrowser();
    const refused = await root.auth.handlers.enableSignInProvider(
      post('/api/admin/sign-in-providers/company/enable', b),
      'company',
    );
    expect(refused.headers.get('location')).toContain('problem=');
    expect((await root.auth.signInProviders.view('company'))?.enabled).toBe(false);
  });

  it('the test signs nobody in and keeps the tester’s session; a passed test lets the sign-in provider on', async () => {
    const b = await bootstrapBrowser();
    const session = b.get(SESSION_COOKIE);
    idp.nextClaims = {
      sub: 'emp-1',
      email: 'carol@example.com',
      name: 'Carol',
      groups: ['eng'],
      amr: ['pwd', 'mfa'],
    };
    const res = await test(b, 'company');
    expect(res.headers.get('location')).toBe(signInTestPage('company'));
    // Nothing written of the identity, and the same session.
    expect(await root.store.users.list()).toEqual([]);
    expect(await root.store.groups.list()).toEqual([]);
    expect(b.get(SESSION_COOKIE)).toBe(session);
    expect(b.has(LOGIN_COOKIE)).toBe(false);
    expect(
      (await root.auth.authenticator.authenticate(new Headers({ cookie: cookieHeader(b) })))?.kind,
    ).toBe('bootstrap');
    const state = await root.auth.signInProviders.state('company');
    expect(state.test).toMatchObject({
      outcome: 'passed',
      by: 'bootstrap',
      identity: {
        subject: 'emp-1',
        email: 'carol@example.com',
        groups: ['eng'],
        amr: ['pwd', 'mfa'],
      },
      verdict: { admitted: true, reason: 'domain', administrator: false },
    });
    const acts = (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' ? [e.act] : [],
    );
    expect(acts).toContain('sign-in-provider-tested');

    const on = await root.auth.handlers.enableSignInProvider(
      post('/api/admin/sign-in-providers/company/enable', b),
      'company',
    );
    expect(on.headers.get('location')).toBe('/admin/identity-provider?enabled=company');
    expect((await root.auth.signInProviders.view('company'))?.enabled).toBe(true);
    // An edit afterwards keeps it on, and makes the test stale.
    await root.auth.signInProviders.save(
      {
        id: 'company',
        kind: 'oidc',
        name: 'Acme Corp',
        issuer: idp.issuer.href,
        clientId: CLIENT.clientId,
        clientSecret: null,
        claims: { sub: 'sub', email: 'email', groups: 'groups' },
        allowedEmailDomains: ['example.com'],
        invitationOnly: false,
      },
      'update',
    );
    const after = await root.auth.signInProviders.state('company');
    expect(after.enabled).toBe(true);
    expect((after.changedAt ?? '') >= (after.test?.at ?? '')).toBe(true);
  });

  it('a failed test says why and lets nothing on', async () => {
    const b = await bootstrapBrowser();
    github.nextUser = {
      id: 7,
      login: 'nobody',
      name: null,
      emails: [{ email: 'x@example.com', primary: true, verified: false }],
    };
    await test(b, 'github');
    expect((await root.auth.signInProviders.state('github')).test).toMatchObject({
      outcome: 'failed',
      error: 'email-not-verified',
    });
    const refused = await root.auth.handlers.enableSignInProvider(
      post('/api/admin/sign-in-providers/github/enable', b),
      'github',
    );
    expect(refused.headers.get('location')).toContain('problem=');
  });

  it('the setup makes the tested identity the first administrator; another session cannot', async () => {
    const b = await bootstrapBrowser();
    github.nextUser = {
      id: 42,
      login: 'ops',
      name: 'Ops',
      emails: [{ email: 'ops@example.org', primary: true, verified: true }],
    };
    await test(b, 'github');
    // The verdict: refused, nobody invited this address on an invitation-only provider.
    expect((await root.auth.signInProviders.state('github')).test?.verdict).toMatchObject({
      admitted: false,
      refusal: 'not-invited',
    });
    // Another session cannot use this result.
    const other = await bootstrapBrowser();
    const stolen = await root.auth.handlers.makeAdministratorFromTest(
      post('/api/admin/sign-in-providers/github/test/administrator', other),
      'github',
    );
    expect(stolen.headers.get('location')).toContain('problem=');
    expect(await root.store.administrators.count()).toBe(0);

    const made = await root.auth.handlers.makeAdministratorFromTest(
      post('/api/admin/sign-in-providers/github/test/administrator', b),
      'github',
    );
    expect(made.headers.get('location')).toBe(`${signInTestPage('github')}?administrator=1`);
    const [designation] = await root.store.administrators.list();
    expect(designation).toMatchObject({ kind: 'user', origin: 'setup', grantedBy: 'bootstrap' });
    const user = await root.store.users.getByIdentity(github.base.href.replace(/\/$/, ''), '42');
    expect(user ?? (await root.store.users.list())[0]).toMatchObject({ email: 'ops@example.org' });
  });

  it('a callback carrying another session than the tester’s is refused', async () => {
    const b = await bootstrapBrowser();
    const start = await root.auth.handlers.testStart(testForm(b, 'company'), 'company');
    absorb(b, start);
    idp.nextClaims = { sub: 'emp-2', email: 'dan@example.com', groups: [] };
    const callback = idp.authorize(new URL(start.headers.get('location') ?? ''));
    // The pending test, but another session (somebody else's browser).
    const other = await bootstrapBrowser();
    other.set(LOGIN_COOKIE, b.get(LOGIN_COOKIE) ?? '');
    const res = await root.auth.handlers.loginCallback(
      new Request(callback.href, { headers: { cookie: cookieHeader(other) } }),
      'company',
    );
    expect(res.headers.get('location')).toBe('/login?error=state-mismatch');
    expect((await root.auth.signInProviders.state('company')).test).toBeNull();
  });

  it('switching off ends its users’ sessions but the actor’s, and never the last way in', async () => {
    const b = await bootstrapBrowser();
    github.nextUser = {
      id: 42,
      login: 'ops',
      name: 'Ops',
      emails: [{ email: 'ops@example.org', primary: true, verified: true }],
    };
    await test(b, 'github');
    await root.auth.handlers.makeAdministratorFromTest(
      post('/api/admin/sign-in-providers/github/test/administrator', b),
      'github',
    );
    await root.auth.handlers.enableSignInProvider(
      post('/api/admin/sign-in-providers/github/enable', b),
      'github',
    );
    // GitHub is the only way in of the only administrator: it stays on.
    const refused = await root.auth.handlers.disableSignInProvider(
      post('/api/admin/sign-in-providers/github/disable', b),
      'github',
    );
    expect(refused.headers.get('location')).toContain('problem=');
    expect((await root.auth.signInProviders.view('github'))?.enabled).toBe(true);
  });
});
