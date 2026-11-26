/**
 * A forgotten password chosen again with the encryption key (ADR
 * administrators-live-in-the-instance, amendment 2026-11-26; intent "Choose a new
 * password with my encryption key"): on a local instance, which sends no mail, the key
 * proven in the browser opens a recovery session in which the person sets a new password
 * and is signed in, loudly, with every former session ended.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keyBytes, proofOf } from '../../../src/components/auth/recovery-proof';
import { SECOND_FACTOR_PAGE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { openMemoryStore } from '../../../src/server/store';
import { ManualClock } from '../../../src/server/store/clock';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'me@example.com';
const FORMER = 'a sentence I forgot since';
const NEW = 'a sentence I remember now';

type Jar = Map<string, string>;
const header = (jar: Jar): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (!name) continue;
    if (attrs.some((a) => a.trim() === 'Max-Age=0') || !value) jar.delete(name.trim());
    else jar.set(name.trim(), value.trim());
  }
}

function form(jar: Jar, fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}/form`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie: header(jar),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function json(jar: Jar, body: unknown): Request {
  return new Request(`${ORIGIN}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: header(jar) },
    body: JSON.stringify(body ?? {}),
  });
}

describe('a forgotten password, chosen again with the encryption key', () => {
  const masterKey = randomBytes(32).toString('base64');
  let root: GatewayRoot;
  let clock: ManualClock;
  let accountId: string;
  let providerId: string;
  /** The session the person had open with the former password. */
  let former: Jar;

  beforeEach(async () => {
    clock = new ManualClock('2026-11-26T10:00:00Z');
    root = await buildRoot({
      loadConfig: () => {
        const loaded = loadInstanceConfig({
          env: {
            VAUBAAN_MASTER_KEY: masterKey,
            VAUBAAN_UPDATES_CHECK: 'false',
            VAUBAAN_LOCAL: 'true',
            VAUBAAN_STORE_PATH: ':memory:',
          },
        });
        return { ...loaded, config: { ...loaded.config, bootstrapToken: 'b'.repeat(43) } };
      },
      logWrite: () => undefined,
      bundled: REPOSITORY_PLUGINS,
      clock,
      openStore: async ({ encryptor, catalog }) => openMemoryStore({ encryptor, catalog, clock }),
    });
    await root.masterKey.service.recordGenerated();
    await root.masterKey.service.confirmHandover();
    former = new Map();
    const bootstrap = (await root.auth.sessions.create({ kind: 'bootstrap' })).id;
    former.set('vbn_session', bootstrap);
    const done = await root.users.handlers.localSetup(
      form(former, { email: EMAIL, password: FORMER, password_again: FORMER }),
    );
    absorb(former, done);
    const [local] = await root.auth.signInProviders.views();
    providerId = local!.id;
    accountId = (await root.auth.signInAccounts.signInAccountOf(providerId, EMAIL))!.id;
    // The password is forgotten a while after the setup.
    clock.advance(60 * 60_000);
  });
  afterEach(async () => {
    await root.close();
  });

  /** The page's steps: a challenge, then the proof made in the browser with `keyText`. */
  async function prove(jar: Jar, keyText: string): Promise<Response> {
    const asked = await root.auth.handlers.recoverChallenge(json(jar, {}));
    absorb(jar, asked);
    const { challenge } = (await asked.json()) as { challenge: string };
    const proof = await proofOf(keyBytes(keyText)!, ORIGIN, challenge);
    const answered = await root.auth.handlers.recoverProof(json(jar, { proof }));
    absorb(jar, answered);
    return answered;
  }

  async function signIn(password: string): Promise<string | null> {
    const res = await root.auth.handlers.passwordLogin(
      form(new Map(), { email: EMAIL, password }),
      providerId,
    );
    return res.headers.get('location');
  }

  it('a wrong key is refused and nothing can be set', async () => {
    const jar: Jar = new Map();
    expect((await prove(jar, randomBytes(32).toString('base64'))).status).toBe(403);
    const res = await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: NEW, password_again: NEW }),
    );
    expect(res.headers.get('location')).toBe('/sign-in-account/forgot');
    expect(await signIn(FORMER)).toBe('/');
  });

  it('with the right key, I set a new password and land on the home page, signed in', async () => {
    const jar: Jar = new Map();
    expect((await prove(jar, masterKey)).status).toBe(200);

    // Two passwords that differ, or a weak one, return to the form; the session stays open.
    const mismatch = await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: NEW, password_again: 'other' }),
    );
    expect(mismatch.headers.get('location')).toBe(
      '/sign-in-account/forgot?error=password-mismatch',
    );
    const weak = await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: 'short', password_again: 'short' }),
    );
    expect(weak.headers.get('location')).toBe('/sign-in-account/forgot?error=password-weak');

    const done = await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: NEW, password_again: NEW }),
    );
    expect(done.headers.get('location')).toBe('/');
    absorb(jar, done);
    expect(jar.has('vbn_recovery')).toBe(false);
    const principal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: header(jar) }),
    );
    expect(principal).toMatchObject({ kind: 'user', isOperator: true });

    // The former password is refused, the new one signs in.
    expect(await signIn(FORMER)).toMatch(/error=password-refused/);
    expect(await signIn(NEW)).toBe('/');

    // The session open with the former password has ended.
    expect(
      await root.auth.authenticator.authenticate(new Headers({ cookie: header(former) })),
    ).toBeNull();

    // The recovery session served once.
    const again = await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: NEW, password_again: NEW }),
    );
    expect(again.headers.get('location')).toBe('/sign-in-account/forgot');
  });

  it('the reset is in the audit and on every page for thirty days', async () => {
    const jar: Jar = new Map();
    await prove(jar, masterKey);
    await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: NEW, password_again: NEW }),
    );
    const entries = await root.store.audit.list({ kind: 'admin' });
    const entry = entries.find((e) => e.kind === 'admin' && e.act === 'password-recovered');
    expect(entry).toMatchObject({ user_id: 'recovery', after: { email: EMAIL } });
    expect(JSON.stringify(entries)).not.toContain(NEW);
    expect(await root.auth.recovery.banner()).toMatchObject({
      act: 'password',
      named: { email: EMAIL },
    });
  });

  it('an account with a second factor still goes through it after the reset', async () => {
    const user = (await root.store.users.list()).find((u) => u.email === EMAIL)!;
    await root.store.secondFactors.set({
      userId: user.id,
      totp: root.auth.secondFactors.beginEnrolment('Test', EMAIL).secret,
      recovery: '[]',
      lastStep: null,
    });
    const jar: Jar = new Map();
    await prove(jar, masterKey);
    const done = await root.auth.handlers.recoverPassword(
      form(jar, { sign_in_account: accountId, password: NEW, password_again: NEW }),
    );
    expect(done.headers.get('location')).toBe(SECOND_FACTOR_PAGE);
  });
});
