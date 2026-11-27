/**
 * Sign-in accounts (spec §0 "Sign-in account", §6; ADR local-accounts-sign-in-provider):
 * the composition root over the `:memory:` store, a sign-in provider of kind `local`
 * added from Settings, the forms driven with web-standard `Request`s. No
 * network, no mail: the links are taken from the service as an administrator
 * would copy them from People.
 */
import { throughSecondFactor } from '../../support/auth/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_LIMITS,
  LOCAL_LOCKOUT,
  LOGIN_COOKIE,
  SECOND_FACTOR_LOCKOUT,
  SESSION_COOKIE,
} from '../../../src/server/auth';
import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { openMemoryStore } from '../../../src/server/store';
import { ManualClock } from '../../../src/server/store/clock';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

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

function cookieOf(res: Response, name: string): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  const [pair] = header.split(';');
  return pair ?? null;
}

function sessionCookieOf(res: Response): string | null {
  return cookieOf(res, SESSION_COOKIE);
}

function formWith(cookie: string | null, fields: Record<string, string>): Request {
  return new Request(`${PUBLIC_URL}/form`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: PUBLIC_URL,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * This file hashes real argon2id passwords (64 MiB each): past the 5 s default on a
 * loaded machine (several worktrees testing at once), never through an assertion.
 */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

describe(
  'sign-in accounts: invitation link, password sign-in, lockout, reset',
  { timeout: HEAVY_TEST_TIMEOUT_MS },
  () => {
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
        bundled: REPOSITORY_PLUGINS,
        clock,
        openStore: async ({ encryptor, catalog }) => openMemoryStore({ encryptor, catalog, clock }),
      });
      await root.auth.signInProviders.save(
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

    /**
     * A sign-in carried through the gateway's second factor (every person has one since
     * ADR administrators-live-in-the-instance §7): the response that lands, its cookies.
     */
    async function through(res: Response): Promise<Response> {
      let jar = res.headers
        .getSetCookie()
        .map((header) => header.split(';')[0])
        .join('; ');
      return throughSecondFactor(
        root,
        PUBLIC_URL,
        res,
        {
          cookie: () => jar,
          absorb: (r) => {
            jar = [jar, ...r.headers.getSetCookie().map((header) => header.split(';')[0])].join(
              '; ',
            );
          },
        },
        clock.now().getTime(),
      );
    }

    async function invitedAccount(): Promise<void> {
      await root.users.invitations.invite('bootstrap', ADA);
      const issued = await root.auth.signInAccounts.createLink({
        kind: 'invite',
        signInProviderId: 'local',
        email: ADA,
        createdBy: 'bootstrap',
      });
      const created = await through(
        await root.auth.handlers.createSignInAccount(
          form({ token: issued.token, password: PASSWORD, password_again: PASSWORD }),
        ),
      );
      expect(created.status).toBe(303);
      expect(created.headers.get('location')).toBe('/');
      expect(sessionCookieOf(created)).not.toBeNull();
    }

    it('the sign-in provider is one of the instance: listed, its users keyed by its urn issuer', async () => {
      const views = await root.auth.signInProviders.views();
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
      const again = await root.auth.signInAccounts.inspectLink('whatever');
      expect(again).toBeNull();
      const entries = await root.store.audit.search({
        scope: {
          missionCreatorUserId: null,
          missionMemberUserId: null,
          accountOwners: [],
          allAdmin: true,
          allCalls: false,
        },
        kind: 'admin',
        limit: 100,
      });
      const acts = entries.map((e) => (e.kind === 'admin' ? e.act : e.kind));
      expect(acts).toContain('local-link-created');
      expect(acts).toContain('sign-in-account-created');
      expect(JSON.stringify(entries)).not.toContain(PASSWORD);
      expect(JSON.stringify(entries)).not.toContain('token');
    });

    it('a link expires after fifteen minutes and a newer link retires the older one', async () => {
      await root.users.invitations.invite('bootstrap', ADA);
      const first = await root.auth.signInAccounts.createLink({
        kind: 'invite',
        signInProviderId: 'local',
        email: ADA,
        createdBy: 'bootstrap',
      });
      const second = await root.auth.signInAccounts.createLink({
        kind: 'invite',
        signInProviderId: 'local',
        email: ADA,
        createdBy: 'bootstrap',
      });
      expect(await root.auth.signInAccounts.inspectLink(first.token)).toBeNull();
      expect(await root.auth.signInAccounts.inspectLink(second.token)).not.toBeNull();
      clock.advance(15 * 60_000 + 1);
      expect(await root.auth.signInAccounts.inspectLink(second.token)).toBeNull();
      const refused = await root.auth.handlers.createSignInAccount(
        form({ token: second.token, password: PASSWORD, password_again: PASSWORD }),
      );
      expect(refused.headers.get('location')).toBe('/sign-in-account/create?error=link-invalid');
    });

    it('a short password and two different passwords are refused, on the same link', async () => {
      await root.users.invitations.invite('bootstrap', ADA);
      const issued = await root.auth.signInAccounts.createLink({
        kind: 'invite',
        signInProviderId: 'local',
        email: ADA,
        createdBy: 'bootstrap',
      });
      const short = await root.auth.handlers.createSignInAccount(
        form({ token: issued.token, password: 'short', password_again: 'short' }),
      );
      expect(short.headers.get('location')).toBe(
        `/sign-in-account/create?error=password-weak&token=${encodeURIComponent(issued.token)}`,
      );
      const differ = await root.auth.handlers.createSignInAccount(
        form({ token: issued.token, password: PASSWORD, password_again: `${PASSWORD}!` }),
      );
      expect(differ.headers.get('location')).toContain('error=password-mismatch');
      expect(await root.auth.signInAccounts.inspectLink(issued.token)).not.toBeNull();
    });

    it('the password signs in; a wrong one, an unknown address and a locked account get one answer', async () => {
      await invitedAccount();
      const ok = await through(await signIn('Ada@Example.com', PASSWORD));
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
      const after = await through(await signIn(ADA, PASSWORD));
      expect(after.headers.get('location')).toBe('/');
      const signInAccount = await root.auth.signInAccounts.signInAccountOf('local', ADA);
      expect(signInAccount?.failedAttempts).toBe(0);
    });

    it('admission stays the instance’s: an invitation removed refuses the next password sign-in', async () => {
      await invitedAccount();
      await root.users.invitations.remove('bootstrap', ADA);
      const refused = await signIn(ADA, PASSWORD);
      expect(refused.headers.get('location')).toBe('/login?error=not-invited');
    });

    it('a deactivated person is refused, as through any sign-in provider', async () => {
      await invitedAccount();
      const [user] = await root.store.users.list();
      if (!user) throw new Error('no user');
      await root.users.service.deactivate({ actorId: 'ops-id', userId: null }, user.id);
      const refused = await signIn(ADA, PASSWORD);
      expect(refused.headers.get('location')).toBe('/login?error=account-deactivated');
    });

    it('a reset link sets a new password once; the old one stops working, and so does every open session', async () => {
      await invitedAccount();
      const before = sessionCookieOf(await through(await signIn(ADA, PASSWORD)));
      expect(
        await root.auth.authenticator.authenticate(new Headers({ cookie: before ?? '' })),
      ).not.toBeNull();
      const issued = await root.auth.signInAccounts.createLink({
        kind: 'reset',
        signInProviderId: 'local',
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
      // Whoever held the old password, and a session opened with it, is out.
      expect(
        await root.auth.authenticator.authenticate(new Headers({ cookie: before ?? '' })),
      ).toBeNull();
      clock.advance(1_000);
      expect((await signIn(ADA, PASSWORD)).headers.get('location')).toBe(
        '/login?error=password-refused',
      );
      expect(
        (await through(await signIn(ADA, 'another sentence of ada'))).headers.get('location'),
      ).toBe('/');
      const twice = await root.auth.handlers.resetPassword(
        form({
          token: issued.token,
          password: 'a third sentence here',
          password_again: 'a third sentence here',
        }),
      );
      expect(twice.headers.get('location')).toBe('/sign-in-account/reset?error=link-invalid');
    });

    it('a reset link needs an account; "forgot" answers the same for every address and makes no link without mail', async () => {
      await expect(
        root.auth.signInAccounts.createLink({
          kind: 'reset',
          signInProviderId: 'local',
          email: 'nobody@example.com',
          createdBy: 'ops-id',
        }),
      ).rejects.toMatchObject({ code: 'sign-in-account-not-found' });
      await invitedAccount();
      const known = await root.auth.handlers.forgotPassword(form({ email: ADA }));
      const unknown = await root.auth.handlers.forgotPassword(form({ email: 'x@example.com' }));
      expect(known.headers.get('location')).toBe('/sign-in-account/forgot?sent=1');
      expect(unknown.headers.get('location')).toBe('/sign-in-account/forgot?sent=1');
      expect(await root.auth.signInAccounts.pendingLinks('local', ADA)).toEqual([]);
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

    describe('the second factor', () => {
      const OPS = 'ops@example.com';
      const OPS_PASSWORD = 'the operator sentence';

      /** The code the authenticator app would show now for the secret of a pending step. */
      function codeNow(secret: string): string {
        const bytes = base32Decode(secret);
        if (!bytes) throw new Error('bad secret');
        return totpCode(bytes, totpStepOf(clock.now().getTime()));
      }

      async function stepOf(res: Response) {
        const cookie = cookieOf(res, LOGIN_COOKIE);
        const step = await root.auth.sessions.peekLocalStep(new Headers({ cookie: cookie ?? '' }));
        if (!step) throw new Error('no pending step');
        return { cookie, step };
      }

      /** The administrator's account, created on its link; its first sign-in enrols the factor. */
      async function enrolledAdministrator(): Promise<{ recoveryCodes: string[]; secret: string }> {
        await root.users.invitations.invite('bootstrap', OPS);
        const issued = await root.auth.signInAccounts.createLink({
          kind: 'invite',
          signInProviderId: 'local',
          email: OPS,
          createdBy: 'bootstrap',
        });
        const created = await root.auth.handlers.createSignInAccount(
          form({ token: issued.token, password: OPS_PASSWORD, password_again: OPS_PASSWORD }),
        );
        // Named by the admin rule and without a second factor: the enrolment comes first.
        expect(created.headers.get('location')).toBe('/login/second-factor');
        expect(sessionCookieOf(created)).toBeNull();
        const { cookie, step } = await stepOf(created);
        expect(step.step).toBe('enrol');
        const secret = step.totpSecret ?? '';
        const wrong = await root.auth.handlers.enrolAtSignIn(
          formWith(cookie, { code: '000000' }),
          'local',
        );
        expect(wrong.headers.get('location')).toBe(
          '/login/second-factor?error=second-factor-refused',
        );
        const again = cookieOf(wrong, LOGIN_COOKIE);
        const done = await root.auth.handlers.enrolAtSignIn(
          formWith(again, { code: codeNow(secret) }),
          'local',
        );
        const location = done.headers.get('location') ?? '';
        expect(location.startsWith('/settings/security?notice=')).toBe(true);
        const session = sessionCookieOf(done);
        expect(session).not.toBeNull();
        const principal = await root.auth.authenticator.authenticate(
          new Headers({ cookie: session ?? '' }),
        );
        expect(principal).toMatchObject({ kind: 'user', isOperator: true });
        const noticeId = new URL(location, PUBLIC_URL).searchParams.get('notice');
        const notice = await root.accounts.notices.take(principal?.sessionId ?? '', noticeId);
        const recoveryCodes = (notice?.codes ?? []).filter((line) =>
          /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(line),
        );
        expect(recoveryCodes).toHaveLength(8);
        return { recoveryCodes, secret };
      }

      it('an administrator enrols a second factor before their first session; the codes are shown once', async () => {
        const { secret } = await enrolledAdministrator();
        // The factor is the person's (ADR administrators-live-in-the-instance §7).
        const [user] = await root.store.users.list();
        expect(await root.auth.secondFactors.has(user?.id ?? '')).toBe(true);
        expect(await root.store.secondFactors.readSecret(user?.id ?? '', 'totp')).toBe(secret);
        const entries = await root.store.audit.search({
          scope: {
            missionCreatorUserId: null,
            missionMemberUserId: null,
            accountOwners: [],
            allAdmin: true,
            allCalls: false,
          },
          kind: 'admin',
          limit: 100,
        });
        expect(JSON.stringify(entries)).toContain('second-factor-changed');
        expect(JSON.stringify(entries)).not.toContain(secret);
      });

      it('the next sign-in asks for the code; a code is accepted once; a recovery code once', async () => {
        const { recoveryCodes, secret } = await enrolledAdministrator();
        const first = await signIn(OPS, OPS_PASSWORD);
        expect(first.headers.get('location')).toBe('/login/code');
        expect(sessionCookieOf(first)).toBeNull();
        const { cookie } = await stepOf(first);
        const refused = await root.auth.handlers.secondFactorLogin(
          formWith(cookie, { code: '123456' }),
          'local',
        );
        expect(refused.headers.get('location')).toBe('/login/code?error=second-factor-refused');
        // The code of the step the enrolment accepted is spent: one step later it is a replay.
        clock.advance(60_000);
        const code = codeNow(secret);
        const ok = await root.auth.handlers.secondFactorLogin(
          formWith(cookieOf(refused, LOGIN_COOKIE), { code }),
          'local',
        );
        expect(ok.headers.get('location')).toBe('/');
        expect(sessionCookieOf(ok)).not.toBeNull();
        const replayStart = await signIn(OPS, OPS_PASSWORD);
        const replay = await root.auth.handlers.secondFactorLogin(
          formWith(cookieOf(replayStart, LOGIN_COOKIE), { code }),
          'local',
        );
        expect(replay.headers.get('location')).toBe('/login/code?error=second-factor-refused');
        const [recovery = ''] = recoveryCodes;
        const byRecovery = await root.auth.handlers.secondFactorLogin(
          formWith(cookieOf(replay, LOGIN_COOKIE), { code: recovery.toUpperCase() }),
          'local',
        );
        expect(byRecovery.headers.get('location')).toBe('/');
        const [opsUser] = await root.store.users.list();
        expect(await root.auth.secondFactors.recoveryCodesLeft(opsUser?.id ?? '')).toBe(7);
        const spent = await root.auth.handlers.secondFactorLogin(
          formWith(cookieOf(await signIn(OPS, OPS_PASSWORD), LOGIN_COOKIE), { code: recovery }),
          'local',
        );
        expect(spent.headers.get('location')).toBe('/login/code?error=second-factor-refused');
        // The step cookie is single-use: a stale one is an expired login.
        const stale = await root.auth.handlers.secondFactorLogin(
          formWith(cookie, { code: codeNow(secret) }),
          'local',
        );
        expect(stale.headers.get('location')).toBe('/login?error=login-expired');
      });

      /** The code form of the second factor's step, answered with `code`. */
      async function answerCode(res: Response, code: string): Promise<Response> {
        return root.auth.handlers.secondFactorLogin(
          formWith(cookieOf(res, LOGIN_COOKIE), { code }),
          'local',
        );
      }

      it('anonymous password posts filling the instance window never stop a person typing their code', async () => {
        const { secret } = await enrolledAdministrator();
        const asked = await signIn(OPS, OPS_PASSWORD);
        const flood = (address: string): Request =>
          new Request(`${PUBLIC_URL}/form`, {
            method: 'POST',
            headers: {
              // Not a form: the window's slot is taken before the body is read, and no
              // password is hashed.
              'content-type': 'text/plain',
              origin: PUBLIC_URL,
              'x-real-ip': address,
            },
            body: 'x',
          });
        const perAddress = AUTH_LIMITS.passwordPerAddress.limit;
        const addresses = Math.ceil(AUTH_LIMITS.passwordPerInstance.limit / perAddress) + 1;
        for (let a = 0; a < addresses; a += 1) {
          for (let i = 0; i < perAddress; i += 1) {
            await root.auth.handlers.passwordLogin(flood(`198.51.100.${a + 1}`), 'local');
          }
        }
        // The password window is full for everybody…
        expect(
          (await root.auth.handlers.passwordLogin(flood('198.51.100.200'), 'local')).headers.get(
            'location',
          ),
        ).toBe('/login?error=too-many-attempts');
        // …and the code of a sign-in already past its password still goes through.
        clock.advance(30_000); // the enrolment used the current step's code
        expect((await answerCode(asked, codeNow(secret))).headers.get('location')).toBe('/');
      });

      it('a wrong code keeps the step’s ten minutes: retrying never extends them', async () => {
        const { secret } = await enrolledAdministrator();
        const asked = await signIn(OPS, OPS_PASSWORD);
        clock.advance(9 * 60_000);
        const wrong = await answerCode(asked, '123456');
        expect(wrong.headers.get('location')).toBe('/login/code?error=second-factor-refused');
        // Ten minutes after the password, the re-issued step is over like the first one.
        clock.advance(60_000);
        const late = await answerCode(wrong, codeNow(secret));
        expect(late.headers.get('location')).toBe('/login?error=login-expired');
        expect(sessionCookieOf(late)).toBeNull();
      });

      it('ten wrong codes lock the second factor for fifteen minutes, the right code included', async () => {
        const { secret } = await enrolledAdministrator();
        let res = await signIn(OPS, OPS_PASSWORD);
        for (let miss = 1; miss < SECOND_FACTOR_LOCKOUT.maxAttempts; miss += 1) {
          res = await answerCode(res, '123456');
          expect(res.headers.get('location')).toBe('/login/code?error=second-factor-refused');
        }
        const locked = await answerCode(res, '123456');
        expect(locked.headers.get('location')).toBe('/login?error=second-factor-locked');
        expect(cookieOf(locked, LOGIN_COOKIE)).toBe(`${LOGIN_COOKIE}=`);
        // The password still opens the step, but no code is checked until the lock passes.
        clock.advance(60_000);
        const refused = await answerCode(await signIn(OPS, OPS_PASSWORD), codeNow(secret));
        expect(refused.headers.get('location')).toBe('/login?error=second-factor-locked');
        clock.advance(SECOND_FACTOR_LOCKOUT.lockMs);
        const open = await answerCode(await signIn(OPS, OPS_PASSWORD), codeNow(secret));
        expect(open.headers.get('location')).toBe('/');
        expect(sessionCookieOf(open)).not.toBeNull();
      });

      it('a right code clears the count of wrong ones', async () => {
        const { secret } = await enrolledAdministrator();
        let res = await signIn(OPS, OPS_PASSWORD);
        for (let miss = 1; miss < SECOND_FACTOR_LOCKOUT.maxAttempts; miss += 1) {
          res = await answerCode(res, '123456');
        }
        clock.advance(60_000);
        expect((await answerCode(res, codeNow(secret))).headers.get('location')).toBe('/');
        const again = await answerCode(await signIn(OPS, OPS_PASSWORD), '123456');
        expect(again.headers.get('location')).toBe('/login/code?error=second-factor-refused');
      });

      it('a recovery code is spent once, even by two posts at the same instant', async () => {
        const { recoveryCodes } = await enrolledAdministrator();
        const [user] = await root.store.users.list();
        const code = recoveryCodes[0] ?? '';
        const [a, b] = await Promise.all([
          root.auth.secondFactors.check(user?.id ?? '', code),
          root.auth.secondFactors.check(user?.id ?? '', code),
        ]);
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      });

      it('an administrator resets a person’s second factor: their next sign-in enrols again', async () => {
        await enrolledAdministrator();
        const [user] = await root.store.users.list();
        if (!user) throw new Error('no user');
        const reset = await root.users.handlers.resetSecondFactor(formWith(null, {}), user.id);
        expect(reset.status).toBe(401); // no session on this request
        await root.auth.secondFactors.reset(user, 'other-admin');
        const next = await signIn(OPS, OPS_PASSWORD);
        expect(next.headers.get('location')).toBe('/login/second-factor');
      });

      it('a person who is not an administrator enrols from Settings → Security and may remove it after a fresh sign-in', async () => {
        await invitedAccount();
        // Every person enrols at their first sign-in now; Settings replaces the factor.
        const signedIn = await through(await signIn(ADA, PASSWORD));
        const session = sessionCookieOf(signedIn);
        const begin = await root.auth.handlers.beginSecondFactor(formWith(session, {}));
        expect(begin.headers.get('location')).toBe('/settings/security?enrol=1');
        const { cookie, step } = await stepOf(begin);
        const confirmed = await root.auth.handlers.confirmSecondFactor(
          formWith(`${session}; ${cookie}`, { code: codeNow(step.totpSecret ?? '') }),
        );
        expect(confirmed.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        const [ada] = await root.store.users.list();
        expect(await root.auth.secondFactors.has(ada?.id ?? '')).toBe(true);
        // The password alone is not enough.
        expect((await signIn(ADA, PASSWORD)).headers.get('location')).toBe('/login/code');
        // Removal needs a session younger than ten minutes.
        clock.advance(11 * 60_000);
        const late = await root.auth.handlers.removeSecondFactor(formWith(session, {}));
        expect(late.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        expect(await root.auth.secondFactors.has(ada?.id ?? '')).toBe(true);
        clock.advance(60_000);
        const fresh = await signIn(ADA, PASSWORD);
        const factor = await root.auth.handlers.secondFactorLogin(
          formWith(cookieOf(fresh, LOGIN_COOKIE), { code: codeNow(step.totpSecret ?? '') }),
          'local',
        );
        const removed = await root.auth.handlers.removeSecondFactor(
          formWith(sessionCookieOf(factor), {}),
        );
        expect(removed.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        expect(await root.auth.secondFactors.has(ada?.id ?? '')).toBe(false);
        // Removed: the next sign-in asks to enrol one again (sign-in accounts are never waived).
        expect((await signIn(ADA, PASSWORD)).headers.get('location')).toBe('/login/second-factor');
      });

      it('a session cannot turn an enrolment from Settings into a fresh session', async () => {
        await invitedAccount();
        const session = sessionCookieOf(await through(await signIn(ADA, PASSWORD)));
        const [ada] = await root.store.users.list();
        // A session someone else holds, past its first ten minutes, cannot replace the factor.
        clock.advance(11 * 60_000);
        const late = await root.auth.handlers.beginSecondFactor(formWith(session, {}));
        expect(late.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        expect(cookieOf(late, LOGIN_COOKIE)).toBeNull();
        // A fresh one may, but the step it gets belongs to Settings: the sign-in route that
        // opens a session refuses it, whatever the code.
        const fresh = sessionCookieOf(await through(await signIn(ADA, PASSWORD)));
        const begin = await root.auth.handlers.beginSecondFactor(formWith(fresh, {}));
        const { cookie, step } = await stepOf(begin);
        expect(step.step).toBe('settings-enrol');
        const smuggled = await root.auth.handlers.enrolAtSignIn(
          formWith(`${fresh}; ${cookie}`, { code: codeNow(step.totpSecret ?? '') }),
          step.signInProviderId,
        );
        expect(smuggled.headers.get('location') ?? '').toMatch(/^\/login\?error=login-expired/);
        expect(sessionCookieOf(smuggled)).toBeNull();
        // Settings itself confirms it and keeps the session it has.
        const again = await root.auth.handlers.beginSecondFactor(formWith(fresh, {}));
        const replaced = await stepOf(again);
        const confirmed = await root.auth.handlers.confirmSecondFactor(
          formWith(`${fresh}; ${replaced.cookie}`, {
            code: codeNow(replaced.step.totpSecret ?? ''),
          }),
        );
        expect(confirmed.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        expect(sessionCookieOf(confirmed)).toBeNull();
        expect(await root.auth.secondFactors.has(ada?.id ?? '')).toBe(true);
      });

      it('a person changes their password with the current one', async () => {
        await invitedAccount();
        const session = sessionCookieOf(await through(await signIn(ADA, PASSWORD)));
        const wrong = await root.auth.handlers.changePassword(
          formWith(session, {
            current_password: 'not it',
            password: 'a brand new sentence',
            password_again: 'a brand new sentence',
          }),
        );
        expect(wrong.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        expect((await signIn(ADA, PASSWORD)).headers.get('location')).toBe('/login/code');
        const changed = await root.auth.handlers.changePassword(
          formWith(session, {
            current_password: PASSWORD,
            password: 'a brand new sentence',
            password_again: 'a brand new sentence',
          }),
        );
        expect(changed.headers.get('location') ?? '').toMatch(/^\/settings\/security\?notice=/);
        expect((await signIn(ADA, PASSWORD)).headers.get('location')).toBe(
          '/login?error=password-refused',
        );
        expect((await signIn(ADA, 'a brand new sentence')).headers.get('location')).toBe(
          '/login/code',
        );
      });
    });

    describe('the setup and the mail', () => {
      const OPS = 'ops@example.com';

      it('the bootstrap operator creates the first administrator; their first sign-in enrols the factor; "Finish setup" retires the token', async () => {
        const bootstrap = await root.auth.sessions.create({ kind: 'bootstrap' });
        const created = await root.users.handlers.createFirstAdministrator(
          formWith(`${SESSION_COOKIE}=${bootstrap.id}`, {
            email: OPS,
            password: 'the operator sentence',
            password_again: 'the operator sentence',
          }),
        );
        expect(created.headers.get('location') ?? '').toMatch(/^\/admin\?notice=/);
        expect(await root.auth.signInAccounts.signInAccountOf('local', OPS)).not.toBeNull();
        // The account administers from its creation: named in the store by the setup.
        const signInAccount = await root.auth.signInAccounts.signInAccountOf('local', OPS);
        const user = await root.store.users.getByIdentity(
          'urn:vaubaan:local:local',
          signInAccount?.id ?? '',
        );
        expect(user?.lastLoginAt).toBeNull();
        expect(await root.store.administrators.ofUser(user?.id ?? '')).toMatchObject({
          origin: 'setup',
          grantedBy: 'bootstrap',
        });
        // Two different passwords: refused, with a notice, nothing created.
        const refused = await root.users.handlers.createFirstAdministrator(
          formWith(`${SESSION_COOKIE}=${bootstrap.id}`, {
            email: 'second@example.com',
            password: 'the operator sentence',
            password_again: 'another sentence entirely',
          }),
        );
        expect(refused.headers.get('location') ?? '').toMatch(/^\/admin\?notice=/);
        expect(
          await root.auth.signInAccounts.signInAccountOf('local', 'second@example.com'),
        ).toBeNull();
        expect((await root.auth.bootstrap.state()).status).toBe('active');
        // The first sign-in: password, then the enrolment, then the session; the token stays.
        const first = await signIn(OPS, 'the operator sentence');
        expect(first.headers.get('location')).toBe('/login/second-factor');
        const cookie = cookieOf(first, LOGIN_COOKIE);
        const step = await root.auth.sessions.peekLocalStep(new Headers({ cookie: cookie ?? '' }));
        const bytes = base32Decode(step?.totpSecret ?? '');
        const code = bytes ? totpCode(bytes, totpStepOf(clock.now().getTime())) : '';
        const done = await root.auth.handlers.enrolAtSignIn(formWith(cookie, { code }), 'local');
        expect(sessionCookieOf(done)).not.toBeNull();
        expect((await root.auth.bootstrap.state()).status).toBe('active');
        // The setup ends by its own step, once an administrator has a way in.
        await root.users.handlers.finishSetup(formWith(`${SESSION_COOKIE}=${bootstrap.id}`, {}));
        expect((await root.auth.bootstrap.state()).status).toBe('revoked');
      });

      it('with a mailer, an invitation and a forgotten password send their links, which the mail alone carries', async () => {
        const sent: { kind: string; to: string; url: URL }[] = [];
        await root.close();
        root = await buildRoot({
          loadConfig: () =>
            loadInstanceConfig({
              env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: OPS }),
            }),
          logWrite: () => undefined,
          bundled: REPOSITORY_PLUGINS,
          clock,
          openStore: async ({ encryptor, catalog }) =>
            openMemoryStore({ encryptor, catalog, clock }),
          mailer: {
            async sendLink(input) {
              sent.push({ kind: input.kind, to: input.to, url: input.url });
            },
          },
        });
        await root.auth.signInProviders.save(
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
        expect(root.auth.sendsMail).toBe(true);
        const bootstrap = await root.auth.sessions.create({ kind: 'bootstrap' });
        const invited = await root.users.handlers.invite(
          formWith(`${SESSION_COOKIE}=${bootstrap.id}`, { email: ADA }),
        );
        expect(invited.status).toBe(303);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'invite', to: ADA });
        const token = sent[0]?.url.searchParams.get('token') ?? '';
        expect(await root.auth.signInAccounts.inspectLink(token)).toMatchObject({
          kind: 'invite',
          email: ADA,
        });
        const created = await root.auth.handlers.createSignInAccount(
          form({ token, password: PASSWORD, password_again: PASSWORD }),
        );
        // The account exists; the first sign-in goes on with the second factor's enrolment.
        expect(created.headers.get('location')).toBe('/login/second-factor');
        await root.auth.handlers.forgotPassword(form({ email: ADA }));
        await root.auth.handlers.forgotPassword(form({ email: 'nobody@example.com' }));
        await vi.waitFor(() => expect(sent.map((m) => m.kind)).toEqual(['invite', 'reset']));
        expect(sent[1]?.url.pathname).toBe('/sign-in-account/reset');
      });

      it('"forgot" answers before the link is made and mailed, for a known address as for an unknown one', async () => {
        let release: () => void = () => undefined;
        const mailing = new Promise<void>((resolve) => {
          release = resolve;
        });
        const sent: string[] = [];
        await root.close();
        root = await buildRoot({
          loadConfig: () =>
            loadInstanceConfig({
              env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: OPS }),
            }),
          logWrite: () => undefined,
          bundled: REPOSITORY_PLUGINS,
          clock,
          openStore: async ({ encryptor, catalog }) =>
            openMemoryStore({ encryptor, catalog, clock }),
          mailer: {
            async sendLink(input) {
              await mailing;
              sent.push(input.to);
            },
          },
        });
        await root.auth.signInProviders.save(
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
        await root.auth.signInAccounts.createSignInAccount({
          signInProviderId: 'local',
          email: ADA,
          password: PASSWORD,
          actor: 'bootstrap',
        });
        const known = await root.auth.handlers.forgotPassword(form({ email: ADA }));
        const unknown = await root.auth.handlers.forgotPassword(form({ email: 'x@example.com' }));
        expect(known.headers.get('location')).toBe(unknown.headers.get('location'));
        // Both answered while the mail of the known address was still being sent.
        expect(sent).toEqual([]);
        release();
        await vi.waitFor(() => expect(sent).toEqual([ADA]));
      });
    });
  },
);
