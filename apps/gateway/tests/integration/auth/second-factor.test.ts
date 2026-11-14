/**
 * The gateway's second factor, for every person whatever their sign-in provider (ADR
 * administrators-live-in-the-instance, §7): enrolled at the first sign-in, asked at
 * every one after, waived per provider by an administrator — always, or when the ID
 * token says `mfa` —, never for an administrator; the factors sign-in accounts kept
 * move to their people at the boot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_COOKIE, SESSION_COOKIE } from '../../../src/server/auth';
import { passSecondFactor } from '../../support/auth/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import { FakeIdp } from './fake-idp';
import { saveTestOidcProvider } from '../../support/auth/testing';

const PUBLIC_URL = 'https://gateway.example.com';
const CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'client-secret-for-tests' };

type Browser = Map<string, string>;
const cookieHeader = (b: Browser): string => [...b].map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(b: Browser, res: Response): void {
  for (const header of res.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (!name) continue;
    if (attrs.some((a) => a.trim() === 'Max-Age=0') || !value) b.delete(name.trim());
    else b.set(name.trim(), value.trim());
  }
}

describe('a second factor for everyone', () => {
  let root: GatewayRoot;
  let idp: FakeIdp;

  beforeEach(async () => {
    idp = new FakeIdp(CLIENT);
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_EMAILS: 'ops@example.com',
          }),
        }),
      logWrite: () => undefined,
      oidc: { fetch: idp.fetch, allowInsecureIssuer: true },
      ...memoryStoreDeps,
    });
    await saveTestOidcProvider(root.store.config, {
      issuer: idp.issuer.href,
      clientId: CLIENT.clientId,
      clientSecret: CLIENT.clientSecret,
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
    });
  });
  afterEach(async () => {
    await root.close();
  });

  async function signIn(b: Browser, claims: Record<string, unknown>): Promise<Response> {
    idp.nextClaims = claims;
    const start = await root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login?return_to=/missions`),
    );
    absorb(b, start);
    const callback = idp.authorize(new URL(start.headers.get('location') ?? ''));
    const finish = await root.auth.handlers.loginCallback(
      new Request(callback.href, { headers: { cookie: cookieHeader(b) } }),
      'idp',
    );
    absorb(b, finish);
    return finish;
  }

  it('a person enrols at their first sign-in, whatever the provider, then gives the code at every one', async () => {
    const b: Browser = new Map();
    const first = await signIn(b, { sub: 'ada', email: 'ada@example.com' });
    expect(first.headers.get('location')).toBe('/login/second-factor');
    expect(b.has(SESSION_COOKIE)).toBe(false);
    // The user exists (the sign-in was admitted); the session waits for the factor.
    const step = await root.auth.sessions.peekLocalStep(new Headers({ cookie: cookieHeader(b) }));
    expect(step).toMatchObject({ step: 'enrol', providerId: 'idp' });
    const wrong = await root.auth.handlers.enrolAtSignIn(
      new Request(`${PUBLIC_URL}/auth/factor/enrol`, {
        method: 'POST',
        headers: {
          cookie: cookieHeader(b),
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'code=000000',
      }),
    );
    expect(wrong.headers.get('location')).toBe('/login/second-factor?error=second-factor-refused');
    absorb(b, wrong);
    const done = await passSecondFactor(root, PUBLIC_URL, cookieHeader(b));
    absorb(b, done!);
    expect(done?.headers.get('location')).toMatch(
      /^\/settings\/security\?notice=.*return_to=%2Fmissions/,
    );
    expect(b.has(SESSION_COOKIE)).toBe(true);
    expect(b.has(LOGIN_COOKIE)).toBe(false);

    const again: Browser = new Map();
    const second = await signIn(again, { sub: 'ada', email: 'ada@example.com' });
    expect(second.headers.get('location')).toBe('/login/code');
    const passed = await passSecondFactor(root, PUBLIC_URL, cookieHeader(again));
    expect(passed?.headers.get('location')).toBe('/missions');
  });

  it('a waiver lets the provider’s people in without the code — never an administrator', async () => {
    await root.auth.providers.setWaiver('idp', 'always');
    const ada: Browser = new Map();
    const res = await signIn(ada, { sub: 'ada', email: 'ada@example.com' });
    expect(res.headers.get('location')).toBe('/missions');
    expect(ada.has(SESSION_COOKIE)).toBe(true);
    const ops: Browser = new Map();
    const admin = await signIn(ops, { sub: 'ops', email: 'ops@example.com' });
    expect(admin.headers.get('location')).toBe('/login/second-factor');
  });

  it('the waiver "amr" holds only when the ID token says the provider asked its own (mfa)', async () => {
    await root.auth.providers.setWaiver('idp', 'amr');
    const withMfa = await signIn(new Map(), {
      sub: 'ada',
      email: 'ada@example.com',
      amr: ['pwd', 'mfa'],
    });
    expect(withMfa.headers.get('location')).toBe('/missions');
    const without = await signIn(new Map(), { sub: 'bob', email: 'bob@example.com', amr: ['pwd'] });
    expect(without.headers.get('location')).toBe('/login/second-factor');
  });

  it('sign-in accounts are never waived, GitHub only "always"; the change is audited', async () => {
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
    await expect(root.auth.providers.setWaiver('local', 'always')).rejects.toMatchObject({
      problems: [expect.stringContaining('cannot be waived')],
    });
    await root.auth.providers.save(
      {
        id: 'github',
        kind: 'github',
        name: '',
        issuer: '',
        clientId: 'gh',
        clientSecret: 'gh-secret',
        allowedEmailDomains: [],
        invitationOnly: true,
      },
      'create',
    );
    await expect(root.auth.providers.setWaiver('github', 'amr')).rejects.toMatchObject({
      problems: [expect.stringContaining('waive it always')],
    });
    const session = await root.auth.sessions.create({ kind: 'bootstrap' });
    const res = await root.auth.handlers.setSecondFactorWaiver(
      new Request(`${PUBLIC_URL}/api/admin/sign-in-providers/github/waiver`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE}=${session.id}`,
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'waiver=always',
      }),
      'github',
    );
    expect(res.headers.get('location')).toBe('/admin/identity-provider?waiver=github');
    expect((await root.auth.providers.state('github')).waiver).toBe('always');
    const acts = (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' ? [e.act] : [],
    );
    expect(acts).toContain('second-factor-waiver-changed');
  });

  it('the factor a sign-in account kept moves to its person at the boot, and still works', async () => {
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
    const account = await root.store.signInAccounts.create({
      provider: 'local',
      email: 'eve@example.com',
    });
    const secret = root.auth.secondFactors.beginEnrolment('Test', 'eve@example.com').secret;
    // As a version before this one stored it: on the account.
    await root.store.signInAccounts.writeSecret(account!.id, 'totp', secret);
    await root.store.signInAccounts.writeSecret(account!.id, 'recovery', '[]');
    await root.store.signInAccounts.setTotp(account!.id, {
      confirmedAt: '2026-10-19T10:00:00.000Z',
      lastStep: 1,
    });

    expect(await root.auth.secondFactors.adoptLocalFactors(['local'])).toBe(1);
    expect(await root.auth.secondFactors.adoptLocalFactors(['local'])).toBe(0);
    expect(await root.store.signInAccounts.readSecret(account!.id, 'totp')).toBeNull();
    const user = await root.store.users.getByIdentity('urn:vaubaan:local:local', account!.id);
    expect(await root.auth.secondFactors.has(user!.id)).toBe(true);
    const bytes = base32Decode(secret)!;
    const check = await root.auth.secondFactors.check(
      user!.id,
      totpCode(bytes, totpStepOf(Date.now())),
    );
    expect(check).toMatchObject({ ok: true, by: 'totp' });
  });
});
