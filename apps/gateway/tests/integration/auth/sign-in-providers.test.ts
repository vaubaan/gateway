/**
 * Several sign-in providers on one instance (spec §0 "Identity provider",
 * "Open provider", "Invitation", §4.3 admin rule, §6 human authentication; ADRs
 * docs/handbook/authentication.md; ADR github-sign-in): the composition
 * root over the `:memory:` store, a company directory through the in-process
 * `FakeIdp` and GitHub through the in-process `FakeGithub`, the host-agnostic
 * handlers driven with web-standard `Request`s. No network.
 */
import { throughSecondFactor } from '../../support/auth/testing';
import { switchOnForTests } from '../../support/auth/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_COOKIE, SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { seedAccount } from '../../support/missions/testing';
import { FakeGithub, routeFetch, type FakeGithubUser } from './fake-github';
import { answerAnyDiscovery, FakeIdp } from './fake-idp';

const PUBLIC_URL = 'https://gateway.example.com';
const ADMIN_TEAM = 'acme/gateway-admins';
const CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'company-client-secret' };
const GITHUB_CLIENT = { clientId: 'Ov23liTest', clientSecret: 'github-client-secret' };

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

const ADA_GITHUB: FakeGithubUser = {
  id: 1001,
  login: 'ada-l',
  name: 'Ada',
  emails: [
    { email: 'ada@example.com', primary: true, verified: true },
    { email: 'ada@home.example.org', primary: false, verified: true },
  ],
};

describe('several sign-in providers: OpenID Connect and GitHub on one instance', () => {
  let root: GatewayRoot;
  let idp: FakeIdp;
  let github: FakeGithub;

  beforeEach(async () => {
    idp = new FakeIdp(CLIENT);
    github = new FakeGithub(GITHUB_CLIENT.clientId, GITHUB_CLIENT.clientSecret);
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_GROUP: `github:${ADMIN_TEAM}`,
            VAUBAAN_ADMIN_EMAILS: 'ops@example.com',
          }),
        }),
      logWrite: () => undefined,
      oidc: {
        fetch: routeFetch({
          [idp.issuer.origin]: idp.fetch,
          [github.base.origin]: github.fetch,
          'https://login.microsoftonline.com': answerAnyDiscovery,
        }),
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
    // Saved off; switched on as a passed test would let an administrator do.
    await switchOnForTests(root.store.config, 'company');
    await switchOnForTests(root.store.config, 'github');
  });
  afterEach(async () => {
    await root.close();
  });

  /** /auth/login/<id> → the sign-in provider's consent → /auth/callback/<callbackId>. */
  async function signIn(
    b: Browser,
    signInProviderId: 'company' | 'github',
    options: { callbackId?: string } = {},
  ): Promise<Response> {
    const start = await root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login/${signInProviderId}?return_to=/`),
      signInProviderId,
    );
    expect(start.status).toBe(303);
    absorbCookies(b, start);
    const location = new URL(start.headers.get('location') ?? '', PUBLIC_URL);
    if (location.origin === PUBLIC_URL) return start;
    const callback =
      signInProviderId === 'github' ? github.authorize(location) : idp.authorize(location);
    const callbackId = options.callbackId ?? signInProviderId;
    const finish = await root.auth.handlers.loginCallback(
      new Request(callback.href, { headers: { cookie: cookieHeader(b) } }),
      callbackId,
    );
    absorbCookies(b, finish);
    // The gateway's own second factor, answered as the person's app would.
    return throughSecondFactor(root, PUBLIC_URL, finish, {
      cookie: () => cookieHeader(b),
      absorb: (r) => absorbCookies(b, r),
    });
  }

  const fresh = (): Browser => ({ cookies: new Map() });

  it('lists both sign-in providers, and /auth/login without a sign-in provider sends the person to choose', async () => {
    expect((await root.auth.signInProviders.views()).map((p) => [p.id, p.kind, p.name])).toEqual([
      ['company', 'oidc', 'Acme'],
      ['github', 'github', 'GitHub'],
    ]);
    const res = await root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login?return_to=/missions`),
    );
    expect(res.headers.get('location')).toBe('/login?return_to=%2Fmissions');
  });

  it('each sign-in provider has its own callback, the sign-in provider idp too', () => {
    expect(root.auth.flows.callbackUrl('github').href).toBe(`${PUBLIC_URL}/auth/callback/github`);
    expect(root.auth.flows.callbackUrl('idp').href).toBe(`${PUBLIC_URL}/auth/callback/idp`);
  });

  it('signs in through the company directory on an allowed domain', async () => {
    idp.nextClaims = { sub: 'emp-1', email: 'carol@example.com', name: 'Carol', groups: [] };
    const b = fresh();
    const res = await signIn(b, 'company');
    expect(res.headers.get('location')).toBe('/');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
    const user = await root.store.users.getByIdentity(idp.iss, 'emp-1');
    expect(user?.email).toBe('carol@example.com');
  });

  it('refuses an uninvited GitHub address and writes nothing; once invited, admits it', async () => {
    github.nextUser = ADA_GITHUB;
    const refused = await signIn(fresh(), 'github');
    expect(refused.headers.get('location')).toBe('/login?error=not-invited');
    expect(await root.store.users.list()).toEqual([]);

    await root.users.invitations.invite('bootstrap', 'Ada@Example.com');
    const b = fresh();
    const admitted = await signIn(b, 'github');
    expect(admitted.headers.get('location')).toBe('/');
    // The subject is the numeric id, never the login; the email the primary verified one.
    const user = await root.store.users.getByIdentity(github.issuer, '1001');
    expect(user).toMatchObject({
      email: 'ada@example.com',
      displayName: 'Ada',
      issuer: github.issuer,
    });
    const principal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieHeader(b) }),
    );
    expect(principal).toMatchObject({
      kind: 'user',
      signInProviderId: 'github',
      isOperator: false,
    });
    // read:org is asked only when a team must be read: the admin rule names one of GitHub's.
    expect(github.requests).toContain('authorize scope=read:user user:email read:org');
  });

  it('never merges identities by email: the same address through two sign-in providers is two users', async () => {
    await root.users.invitations.invite('bootstrap', 'ada@example.com');
    idp.nextClaims = { sub: 'emp-ada', email: 'ada@example.com', name: 'Ada', groups: [] };
    await signIn(fresh(), 'company');
    github.nextUser = ADA_GITHUB;
    await signIn(fresh(), 'github');
    const users = await root.store.users.findByEmail('ada@example.com');
    expect(users.map((u) => u.issuer).sort()).toEqual([github.issuer, idp.iss].sort());
    expect(new Set(users.map((u) => u.id)).size).toBe(2);
  });

  it('refuses a GitHub account whose primary address is not verified, even when invited', async () => {
    await root.users.invitations.invite('bootstrap', 'eve@example.com');
    github.nextUser = {
      id: 2002,
      login: 'eve',
      name: null,
      emails: [
        { email: 'eve@example.com', primary: true, verified: false },
        { email: 'eve@elsewhere.example.org', primary: false, verified: true },
      ],
    };
    const res = await signIn(fresh(), 'github');
    expect(res.headers.get('location')).toBe('/login?error=email-not-verified');
    expect(await root.store.users.list()).toEqual([]);
  });

  it('refuses an unverified email that is on the admin list, through the directory too', async () => {
    idp.nextClaims = { sub: 'x', email: 'ops@example.com', email_verified: false, groups: [] };
    const res = await signIn(fresh(), 'company');
    expect(res.headers.get('location')).toBe('/login?error=email-not-verified');
    expect(await root.store.users.list()).toEqual([]);
    expect((await root.auth.bootstrap.state()).status).toBe('active');
  });

  it('a callback for sign-in provider A never completes an attempt started for sign-in provider B', async () => {
    github.nextUser = ADA_GITHUB;
    await root.users.invitations.invite('bootstrap', 'ada@example.com');
    const b = fresh();
    const res = await signIn(b, 'github', { callbackId: 'company' });
    expect(res.headers.get('location')).toBe('/login?error=state-mismatch');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(b.cookies.has(LOGIN_COOKIE)).toBe(false);
    expect(await root.store.users.list()).toEqual([]);
  });

  it('the admin rule names its sign-in provider: a GitHub team counts, the same group from the directory does not', async () => {
    await root.users.invitations.invite('bootstrap', 'grace@example.com');
    github.nextUser = {
      id: 3003,
      login: 'grace',
      name: 'Grace',
      emails: [{ email: 'grace@example.com', primary: true, verified: true }],
      teams: [ADMIN_TEAM],
    };
    const b = fresh();
    await signIn(b, 'github');
    const grace = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieHeader(b) }),
    );
    expect(grace).toMatchObject({ kind: 'user', isOperator: true });
    // A sign-in revokes nothing: the setup ends by its own step.
    expect((await root.auth.bootstrap.state()).status).toBe('active');

    idp.nextClaims = { sub: 'emp-2', email: 'mallory@example.com', groups: [ADMIN_TEAM] };
    const m = fresh();
    await signIn(m, 'company');
    const mallory = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieHeader(m) }),
    );
    expect(mallory).toMatchObject({ kind: 'user', isOperator: false });
    // The directory's group of that name is GitHub's, so the claim is skipped, not joined.
    expect(mallory?.kind === 'user' ? mallory.groups.map((g) => g.name) : null).toEqual([]);
  });

  it('a team GitHub cannot answer for is unknown, not "none": the sign-in is refused', async () => {
    await root.users.invitations.invite('bootstrap', 'grace@example.com');
    github.teamsStatus = 403;
    github.nextUser = {
      id: 3003,
      login: 'grace',
      name: 'Grace',
      emails: [{ email: 'grace@example.com', primary: true, verified: true }],
    };
    const res = await signIn(fresh(), 'github');
    expect(res.headers.get('location')).toBe('/login?error=groups-unavailable');
    expect(await root.store.users.list()).toEqual([]);
  });

  it('the admin emails are admitted on an invitation-only sign-in provider', async () => {
    github.nextUser = {
      id: 4004,
      login: 'ops',
      name: 'Ops',
      emails: [{ email: 'ops@example.com', primary: true, verified: true }],
    };
    const b = fresh();
    expect((await signIn(b, 'github')).headers.get('location')).toBe('/');
    const ops = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieHeader(b) }),
    );
    expect(ops).toMatchObject({ isOperator: true });
  });

  it('a member of the admin team is admitted on the invitation-only sign-in provider, and is an operator', async () => {
    github.nextUser = {
      id: 5005,
      login: 'hal',
      name: 'Hal',
      emails: [{ email: 'hal@contractor.example', primary: true, verified: true }],
      teams: [ADMIN_TEAM],
    };
    const b = fresh();
    expect((await signIn(b, 'github')).headers.get('location')).toBe('/');
    const hal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieHeader(b) }),
    );
    expect(hal).toMatchObject({ kind: 'user', isOperator: true });
    // Not an invitee: out of the team, the next sign-in is refused like anyone's.
    github.nextUser = { ...github.nextUser, teams: [] };
    expect((await signIn(fresh(), 'github')).headers.get('location')).toBe(
      '/login?error=not-invited',
    );
  });

  it('the Entra ID preset writes the issuer from the tenant; a word that is no tenant is refused by name', async () => {
    github.nextUser = {
      id: 4004,
      login: 'ops',
      name: 'Ops',
      emails: [{ email: 'ops@example.com', primary: true, verified: true }],
    };
    const b = fresh();
    await signIn(b, 'github');
    const save = (fields: Record<string, string>) =>
      root.auth.handlers.saveIdpSettings(
        new Request(`${PUBLIC_URL}/api/admin/sign-in-providers`, {
          method: 'POST',
          headers: {
            cookie: cookieHeader(b),
            origin: PUBLIC_URL,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            mode: 'create',
            kind: 'oidc',
            preset: 'entra',
            sign_in_provider_id: 'entra',
            name: 'Entra ID',
            client_id: 'app-client-id',
            client_secret: 'app-secret',
            claim_sub: 'sub',
            claim_email: 'email',
            claim_groups: 'groups',
            admission: 'everyone',
            ...fields,
          }).toString(),
        }),
      );
    const refused = await save({ tenant: 'common' });
    const back = new URL(refused.headers.get('location') ?? '', PUBLIC_URL);
    expect(back.pathname).toBe('/admin/identity-provider/new');
    expect(back.searchParams.get('kind')).toBe('entra');
    expect(back.searchParams.get('tenant')).toBe('common');
    expect(back.searchParams.get('problem')).toContain('not an Entra ID tenant');
    expect(await root.auth.signInProviders.view('entra')).toBeNull();

    const saved = await save({ tenant: 'Contoso.onmicrosoft.com' });
    expect(saved.headers.get('location')).toBe('/admin/identity-provider?saved=entra');
    const view = await root.auth.signInProviders.view('entra');
    expect(view?.kind).toBe('oidc');
    expect(view?.issuer.href).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
    );
    expect(view?.allowedEmailDomains).toEqual([]);
    expect(view?.invitationOnly).toBe(false);
  });

  it('removing an invitation refuses the next sign-in and leaves an open session', async () => {
    await root.users.invitations.invite('bootstrap', 'ada@example.com');
    github.nextUser = ADA_GITHUB;
    const b = fresh();
    await signIn(b, 'github');
    await root.users.invitations.remove('bootstrap', 'ada@example.com');
    expect(
      await root.auth.authenticator.authenticate(new Headers({ cookie: cookieHeader(b) })),
    ).toMatchObject({ kind: 'user' });
    const again = await signIn(fresh(), 'github');
    expect(again.headers.get('location')).toBe('/login?error=not-invited');
  });

  it('removing a sign-in provider: its users cannot sign in, their sessions end, their missions follow the deactivation rules', async () => {
    await root.users.invitations.invite('bootstrap', 'ada@example.com');
    github.nextUser = ADA_GITHUB;
    const b = fresh();
    await signIn(b, 'github');
    const ada = await root.store.users.getByIdentity(github.issuer, '1001');
    if (!ada) throw new Error('Ada was not created');
    const seeded = await seedAccount(root.store, {
      service: 'github',
      owner: { kind: 'user', id: ada.id },
      displayName: 'ada-org',
      resources: [{ ref: 'ada/app' }],
    });
    const issued = await root.missions.service.issue(ada, {
      name: 'ada-app',
      accounts: [
        {
          account_id: seeded.account.id,
          trust_levels: { read: 'trusting', propose: 'trusting' },
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error('the mission was not issued');

    await root.auth.signInProviders.remove('github');
    await root.store.users.endSessionsOfIssuer(github.issuer);

    // The session is over and no new sign-in can start.
    expect(
      await root.auth.authenticator.authenticate(new Headers({ cookie: cookieHeader(b) })),
    ).toBeNull();
    const start = await root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login/github`),
      'github',
    );
    expect(start.headers.get('location')).toBe('/login?error=sign-in-provider-unknown');
    // Nothing else changed: the user is active and the mission still serves, as for anyone
    // the identity provider stopped vouching for, until an administrator deactivates them.
    expect((await root.store.users.getById(ada.id))?.status).toBe('active');
    const still = await root.missions.service.verifyToken(issued.token.secret);
    expect(still).toMatchObject({ outcome: 'verified', mission: { status: 'active' } });

    // Deactivating them is what stops the mission: it is orphaned by the derived rule.
    const done = await root.users.service.deactivate(
      { actorId: 'bootstrap', userId: null },
      ada.id,
    );
    expect(done.orphaned).toBe(1);
  });

  it('Settings removes a sign-in provider for an administrator: audited, sessions of its users ended at once', async () => {
    // Ops signs in through GitHub (an admin email: admitted, administrator).
    github.nextUser = {
      id: 4004,
      login: 'ops',
      name: 'Ops',
      emails: [{ email: 'ops@example.com', primary: true, verified: true }],
    };
    const ops = fresh();
    await signIn(ops, 'github');
    idp.nextClaims = { sub: 'emp-1', email: 'carol@example.com', groups: [] };
    const carol = fresh();
    await signIn(carol, 'company');

    const res = await root.auth.handlers.removeSignInProvider(
      new Request(`${PUBLIC_URL}/api/admin/sign-in-providers/company/remove`, {
        method: 'POST',
        headers: {
          cookie: cookieHeader(ops),
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: '',
      }),
      'company',
    );
    expect(res.headers.get('location')).toBe('/admin/identity-provider?removed=company&people=1');
    expect(
      await root.auth.authenticator.authenticate(new Headers({ cookie: cookieHeader(carol) })),
    ).toBeNull();
    // The administrator's own session, through GitHub, is untouched.
    expect(
      await root.auth.authenticator.authenticate(new Headers({ cookie: cookieHeader(ops) })),
    ).toMatchObject({ kind: 'user' });
    const entries = await root.store.audit.list({ kind: 'admin' });
    const removal = entries.find(
      (e) => e.kind === 'admin' && e.object.id === 'sign-in:company' && e.after === null,
    );
    expect(removal).toBeDefined();
    expect(JSON.stringify(removal)).not.toContain(CLIENT.clientSecret);
  });

  it('refuses to add a second sign-in provider of the same issuer', async () => {
    await expect(
      root.auth.signInProviders.save(
        {
          id: 'company-two',
          kind: 'oidc',
          name: '',
          issuer: idp.issuer.href,
          clientId: 'another',
          clientSecret: 'another-secret',
          allowedEmailDomains: ['example.com'],
          invitationOnly: false,
        },
        'create',
      ),
    ).rejects.toMatchObject({
      problems: [expect.stringContaining("sign-in provider 'company' already")],
    });
  });

  it('refuses a GitHub sign-in provider without an admission rule, saying why', async () => {
    await expect(
      root.auth.signInProviders.save(
        {
          id: 'github-two',
          kind: 'github',
          name: '',
          issuer: 'http://ghe.test',
          clientId: 'x',
          clientSecret: 'y',
          allowedEmailDomains: [],
          invitationOnly: false,
        },
        'create',
      ),
    ).rejects.toMatchObject({ problems: [expect.stringContaining('needs an admission rule')] });
  });
});
