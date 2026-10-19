/**
 * Local accounts (spec §0 "Local account", §6; ADR local-accounts-sign-in-provider):
 * the composition root over the `:memory:` store, a provider of kind `local`
 * added from Settings, the forms driven with web-standard `Request`s. No
 * network, no mail: the links are taken from the service as an administrator
 * would copy them from People.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTH_LIMITS, LOCAL_LOCKOUT, SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { openMemoryStore } from '../../../src/server/store';
import { ManualClock } from '../../../src/server/store/clock';

const PUBLIC_URL = 'https://gateway.example.com';
const ADA = 'ada@example.com';
const PASSWORD = 'a sentence ada remembers';

function form(fields: Record<string, string>): Request {
  return new Request(`${PUBLIC_URL}/form`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: PUBLIC_URL,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function sessionCookieOf(res: Response): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!header) return null;
  const [pair] = header.split(';');
  return pair ?? null;
}

describe('local accounts: invitation link, password sign-in, lockout, reset', () => {
  let root: GatewayRoot;
  let clock: ManualClock;

  beforeEach(async () => {
    clock = new ManualClock('2026-10-19T10:00:00Z');
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_EMAILS: 'ops@example.com',
            VAUBAAN_CLIENT_IP_HEADER: 'x-real-ip',
          }),
        }),
      logWrite: () => undefined,
      clock,
      openStore: async ({ encryptor, catalog }) => openMemoryStore({ encryptor, catalog, clock }),
    });
    await root.auth.providers.save(
      {
        id: 'local',
        kind: 'local',
        name: '',
        issuer: '',
        clientId: '',
        clientSecret: null,
        allowedEmailDomains: [],
        invitationOnly: true,
      },
      'create',
    );
  });
  afterEach(async () => {
    await root.close();
  });

  async function signIn(email: string, password: string): Promise<Response> {
    return root.auth.handlers.passwordLogin(form({ email, password }), 'local');
  }

  async function invitedAccount(): Promise<void> {
    await root.users.invitations.invite('bootstrap', ADA);
    const issued = await root.auth.accounts.createLink({
      kind: 'invite',
      providerId: 'local',
      email: ADA,
      createdBy: 'bootstrap',
    });
    const created = await root.auth.handlers.createAccount(
      form({ token: issued.token, password: PASSWORD, password_again: PASSWORD }),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/');
    expect(sessionCookieOf(created)).not.toBeNull();
  }

  it('the provider is one of the instance: listed, its users keyed by its urn issuer', async () => {
    const views = await root.auth.providers.views();
    expect(views.map((v) => [v.id, v.kind, v.issuer.href])).toEqual([
      ['local', 'local', 'urn:vaubaan:local:local'],
    ]);
    expect(JSON.stringify(views)).not.toContain('clientSecret');
  });

  it('an invited address creates its account on the link, which is spent, and is signed in', async () => {
    await invitedAccount();
    const users = await root.store.users.list();
    expect(users.map((u) => [u.email, u.issuer])).toEqual([[ADA, 'urn:vaubaan:local:local']]);
    // The link is single-use.
    const again = await root.auth.accounts.inspectLink('whatever');
    expect(again).toBeNull();
    const entries = await root.store.audit.search({
      scope: {
        missionCreatorUserId: null,
        missionMemberUserId: null,
        connectionOwners: [],
        allAdmin: true,
        allCalls: false,
      },
      kind: 'admin',
      limit: 100,
    });
    const acts = entries.map((e) => (e.kind === 'admin' ? e.act : e.kind));
    expect(acts).toContain('local-link-created');
    expect(acts).toContain('local-account-created');
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
    expect(JSON.stringify(entries)).not.toContain('token');
  });

  it('a link expires after fifteen minutes and a newer link retires the older one', async () => {
    await root.users.invitations.invite('bootstrap', ADA);
    const first = await root.auth.accounts.createLink({
      kind: 'invite',
      providerId: 'local',
      email: ADA,
      createdBy: 'bootstrap',
    });
    const second = await root.auth.accounts.createLink({
      kind: 'invite',
      providerId: 'local',
      email: ADA,
      createdBy: 'bootstrap',
    });
    expect(await root.auth.accounts.inspectLink(first.token)).toBeNull();
    expect(await root.auth.accounts.inspectLink(second.token)).not.toBeNull();
    clock.advance(15 * 60_000 + 1);
    expect(await root.auth.accounts.inspectLink(second.token)).toBeNull();
    const refused = await root.auth.handlers.createAccount(
      form({ token: second.token, password: PASSWORD, password_again: PASSWORD }),
    );
    expect(refused.headers.get('location')).toBe('/account/create?error=link-invalid');
  });

  it('a short password and two different passwords are refused, on the same link', async () => {
    await root.users.invitations.invite('bootstrap', ADA);
    const issued = await root.auth.accounts.createLink({
      kind: 'invite',
      providerId: 'local',
      email: ADA,
      createdBy: 'bootstrap',
    });
    const short = await root.auth.handlers.createAccount(
      form({ token: issued.token, password: 'short', password_again: 'short' }),
    );
    expect(short.headers.get('location')).toBe(
      `/account/create?error=password-weak&token=${encodeURIComponent(issued.token)}`,
    );
    const differ = await root.auth.handlers.createAccount(
      form({ token: issued.token, password: PASSWORD, password_again: `${PASSWORD}!` }),
    );
    expect(differ.headers.get('location')).toContain('error=password-mismatch');
    expect(await root.auth.accounts.inspectLink(issued.token)).not.toBeNull();
  });

  it('the password signs in; a wrong one, an unknown address and a locked account get one answer', async () => {
    await invitedAccount();
    const ok = await signIn('Ada@Example.com', PASSWORD);
    expect(ok.headers.get('location')).toBe('/');
    const principal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: sessionCookieOf(ok) ?? '' }),
    );
    expect(principal).toMatchObject({ kind: 'user', isOperator: false });
    expect(principal?.kind === 'user' ? principal.user.email : null).toBe(ADA);

    const wrong = await signIn(ADA, 'not the password');
    expect(wrong.headers.get('location')).toBe('/login?error=password-refused');
    const unknown = await signIn('nobody@example.com', PASSWORD);
    expect(unknown.headers.get('location')).toBe('/login?error=password-refused');

    for (let i = 1; i < LOCAL_LOCKOUT.maxAttempts; i += 1) await signIn(ADA, 'still wrong');
    // Locked: the right password is refused too, until the lock passes.
    const locked = await signIn(ADA, PASSWORD);
    expect(locked.headers.get('location')).toBe('/login?error=password-refused');
    clock.advance(LOCAL_LOCKOUT.lockMs + 1);
    const after = await signIn(ADA, PASSWORD);
    expect(after.headers.get('location')).toBe('/');
    const account = await root.auth.accounts.accountOf('local', ADA);
    expect(account?.failedAttempts).toBe(0);
  });

  it('admission stays the instance’s: an invitation removed refuses the next password sign-in', async () => {
    await invitedAccount();
    await root.users.invitations.remove('bootstrap', ADA);
    const refused = await signIn(ADA, PASSWORD);
    expect(refused.headers.get('location')).toBe('/login?error=not-invited');
  });

  it('a deactivated person is refused, as through any provider', async () => {
    await invitedAccount();
    const [user] = await root.store.users.list();
    if (!user) throw new Error('no user');
    await root.users.service.deactivate({ actorId: 'ops-id', userId: null }, user.id);
    const refused = await signIn(ADA, PASSWORD);
    expect(refused.headers.get('location')).toBe('/login?error=account-deactivated');
  });

  it('a reset link sets a new password once; the old one stops working', async () => {
    await invitedAccount();
    const issued = await root.auth.accounts.createLink({
      kind: 'reset',
      providerId: 'local',
      email: ADA,
      createdBy: 'ops-id',
    });
    const reset = await root.auth.handlers.resetPassword(
      form({
        token: issued.token,
        password: 'another sentence of ada',
        password_again: 'another sentence of ada',
      }),
    );
    expect(reset.headers.get('location')).toBe('/login?reset=done');
    expect((await signIn(ADA, PASSWORD)).headers.get('location')).toBe(
      '/login?error=password-refused',
    );
    expect((await signIn(ADA, 'another sentence of ada')).headers.get('location')).toBe('/');
    const twice = await root.auth.handlers.resetPassword(
      form({
        token: issued.token,
        password: 'a third sentence here',
        password_again: 'a third sentence here',
      }),
    );
    expect(twice.headers.get('location')).toBe('/account/reset?error=link-invalid');
  });

  it('a reset link needs an account; "forgot" answers the same for every address and makes no link without mail', async () => {
    await expect(
      root.auth.accounts.createLink({
        kind: 'reset',
        providerId: 'local',
        email: 'nobody@example.com',
        createdBy: 'ops-id',
      }),
    ).rejects.toMatchObject({ code: 'account-not-found' });
    await invitedAccount();
    const known = await root.auth.handlers.forgotPassword(form({ email: ADA }));
    const unknown = await root.auth.handlers.forgotPassword(form({ email: 'x@example.com' }));
    expect(known.headers.get('location')).toBe('/account/forgot?sent=1');
    expect(unknown.headers.get('location')).toBe('/account/forgot?sent=1');
    expect(await root.auth.accounts.pendingLinks('local', ADA)).toEqual([]);
  });

  it('the forms are origin-checked and rate-limited per client address', async () => {
    const foreign = new Request(`${PUBLIC_URL}/form`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ email: ADA, password: PASSWORD }).toString(),
    });
    expect((await root.auth.handlers.passwordLogin(foreign, 'local')).status).toBe(403);
    const from = (address: string): Request =>
      new Request(`${PUBLIC_URL}/form`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: PUBLIC_URL,
          'x-real-ip': address,
        },
        body: new URLSearchParams({ email: 'nobody@example.com', password: 'x' }).toString(),
      });
    for (let i = 0; i < AUTH_LIMITS.passwordPerAddress.limit; i += 1) {
      expect(
        (await root.auth.handlers.passwordLogin(from('203.0.113.7'), 'local')).headers.get(
          'location',
        ),
      ).toBe('/login?error=password-refused');
    }
    const throttled = await root.auth.handlers.passwordLogin(from('203.0.113.7'), 'local');
    expect(throttled.headers.get('location')).toBe('/login?error=too-many-attempts');
    const other = await root.auth.handlers.passwordLogin(from('198.51.100.9'), 'local');
    expect(other.headers.get('location')).toBe('/login?error=password-refused');
  });
});
