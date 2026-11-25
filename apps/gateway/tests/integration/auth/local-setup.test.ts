/**
 * A local instance's setup (ADR local-mode-for-an-instance-on-this-computer; ADR
 * local-accounts-sign-in-provider, amendment 2026-11-25): the key, then one form that
 * turns sign-in accounts on, makes the person the administrator, ends the setup and
 * signs them in; their next sign-in takes the password alone.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth/cookies';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { openMemoryStore } from '../../../src/server/store';
import { ManualClock } from '../../../src/server/store/clock';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'me@example.com';
const PASSWORD = 'a sentence I remember';

function post(
  cookie: string | null,
  fields: Record<string, string>,
  origin: string = ORIGIN,
): Request {
  return new Request(`${origin}/form`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function sessionOf(res: Response): string | null {
  const header = res.headers
    .getSetCookie()
    .find((c) => c.startsWith('vbn_session=') && !c.startsWith('vbn_session=;'));
  return header?.split(';')[0] ?? null;
}

async function rootFor(local: boolean, clock: ManualClock): Promise<GatewayRoot> {
  const env: Record<string, string> = {
    VAUBAAN_MASTER_KEY: randomBytes(32).toString('base64'),
    VAUBAAN_UPDATES_CHECK: 'false',
  };
  if (local) {
    env.VAUBAAN_LOCAL = 'true';
    env.VAUBAAN_STORE_PATH = ':memory:';
  } else {
    env.VAUBAAN_PUBLIC_URL = 'https://gateway.example.com';
    env.VAUBAAN_STORE_PATH = ':memory:';
    env.VAUBAAN_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  }
  return buildRoot({
    loadConfig: () => {
      const loaded = loadInstanceConfig({ env });
      // Local mode makes its token at the start (compose/boot-config.ts).
      return local
        ? { ...loaded, config: { ...loaded.config, bootstrapToken: 'b'.repeat(43) } }
        : loaded;
    },
    logWrite: () => undefined,
    bundled: REPOSITORY_PLUGINS,
    clock,
    openStore: async ({ encryptor, catalog }) => openMemoryStore({ encryptor, catalog, clock }),
  });
}

describe('the setup of a local instance', () => {
  let root: GatewayRoot;
  let clock: ManualClock;
  let bootstrap: string;

  beforeEach(async () => {
    clock = new ManualClock('2026-11-25T10:00:00Z');
    root = await rootFor(true, clock);
    bootstrap = `vbn_session=${(await root.auth.sessions.create({ kind: 'bootstrap' })).id}`;
  });
  afterEach(async () => {
    await root.close();
  });

  it('waits for the key, then makes the account, the administrator, the end of the setup and the session', async () => {
    await root.masterKey.service.recordGenerated();
    const early = await root.users.handlers.localSetup(
      post(bootstrap, { email: EMAIL, password: PASSWORD, password_again: PASSWORD }),
    );
    expect(early.headers.get('location')).toBe('/welcome');
    expect(await root.auth.signInProviders.views()).toEqual([]);

    await root.masterKey.service.confirmHandover();
    const done = await root.users.handlers.localSetup(
      post(bootstrap, { email: EMAIL, password: PASSWORD, password_again: PASSWORD }),
    );
    expect(done.headers.get('location')).toBe('/');
    expect((await root.auth.bootstrap.state()).status).toBe('revoked');
    const [local] = await root.auth.signInProviders.views();
    expect(local).toMatchObject({ kind: 'local', enabled: true });
    const account = await root.auth.signInAccounts.signInAccountOf(local?.id ?? '', EMAIL);
    expect(account).not.toBeNull();

    // The person is signed in, as an administrator.
    const cookie = sessionOf(done);
    expect(cookie).not.toBeNull();
    const principal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookie ?? '' }),
    );
    expect(principal).toMatchObject({ kind: 'user', isOperator: true });

    // Their next sign-in takes the password alone: no second factor to enrol.
    const again = await root.auth.handlers.passwordLogin(
      post(null, { email: EMAIL, password: PASSWORD }),
      local?.id ?? 'local',
    );
    expect(again.headers.get('location')).toBe('/');
    expect(sessionOf(again)).not.toBeNull();
  });

  it('refuses two different passwords and keeps the setup open', async () => {
    const refused = await root.users.handlers.localSetup(
      post(bootstrap, { email: EMAIL, password: PASSWORD, password_again: 'something else' }),
    );
    expect(refused.headers.get('location') ?? '').toMatch(/^\/welcome\?notice=/);
    expect((await root.auth.bootstrap.state()).status).toBe('active');
  });
});

describe('outside local mode', () => {
  it('has no such form', async () => {
    const clock = new ManualClock('2026-11-25T10:00:00Z');
    const root = await rootFor(false, clock);
    try {
      // An https instance: the session cookie is the __Host- one.
      const operator = `${SESSION_COOKIE}=${(await root.auth.sessions.create({ kind: 'bootstrap' })).id}`;
      const res = await root.users.handlers.localSetup(
        post(operator, { email: EMAIL }, 'https://gateway.example.com'),
      );
      expect(res.status).toBe(404);
    } finally {
      await root.close();
    }
  });
});
