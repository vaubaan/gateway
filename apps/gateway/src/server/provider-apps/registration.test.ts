/**
 * Creating the company's app from the manifest flow (ADR
 * company-app-created-from-a-manifest), against the GitHub plugin as shipped
 * and a mocked GitHub: the manifest per permission choice, the state
 * (single use, expiry, bound to the session), every failure of the exchange,
 * the refusals (configuration file, an app already set), what is stored and
 * where, the audit entry without a secret, the logs without a secret.
 */
import { MemoryAuditWriter, type AdminAuditEntry } from '@vaubaan/gateway-core';
import githubPlugin from '@vaubaan/plugin-github';
import { createRegistry, defaultPermissionChoice, type ProviderPlugin } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { MemorySessionStore } from '../compose/memory';
import { fixturePlugin, UNVERIFIED_APP_INSTALL_SPEC } from '../connections/testing';
import { createLogger } from '../logging';
import { openTestStore } from '../store/testing';
import {
  AppRegistrationError,
  AppRegistrationService,
  REGISTRATION_TTL_MS,
  registrationReturnPath,
  type RegistrationErrorCode,
} from './registration';
import { providerAppKey, ProviderAppsService, registrationKey } from './service';

const PUBLIC_URL = new URL('https://gateway.acme.test/');
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeymaterial\n-----END RSA PRIVATE KEY-----';
const CLIENT_SECRET = 'github-client-secret-value';
const WEBHOOK_SECRET = 'webhook-secret-value';
const CODE = 'a180b1a3d263c81bc6441d7b990bae27d4c10679';
const CONVERSION = `https://api.github.com/app-manifests/${CODE}/conversions`;
const SESSION = 'session-of-the-administrator';
const ACTOR = { sessionId: SESSION, actorId: 'user-ops' };

const ANSWER = {
  id: 424242,
  slug: 'vaubaan-gateway-acme-test',
  name: 'Vaubaan gateway.acme.test',
  owner: { login: 'vaubaan', type: 'Organization' },
  html_url: 'https://github.com/apps/vaubaan-gateway-acme-test',
  permissions: { metadata: 'read', contents: 'read' },
  client_id: 'Iv23liAcme',
  client_secret: CLIENT_SECRET,
  webhook_secret: WEBHOOK_SECRET,
  pem: PEM,
};

const conversion = (patch: Partial<MockRoute> = {}): MockRoute => ({
  method: 'POST',
  url: CONVERSION,
  status: 201,
  body: ANSWER,
  ...patch,
});

const byHand = fixturePlugin({
  id: 'appco',
  displayName: 'App Co',
  credential: UNVERIFIED_APP_INSTALL_SPEC,
});

function setup(
  options: {
    routes?: readonly MockRoute[];
    fromFile?: boolean;
    plugins?: readonly ProviderPlugin[];
  } = {},
) {
  const test = openTestStore();
  const registry = createRegistry(options.plugins ?? [githubPlugin, byHand]);
  const fromFile = new Map(
    options.fromFile
      ? [
          [
            'github',
            { appId: '1', appSlug: 'x', privateKey: PEM, clientId: 'c', clientSecret: 's' },
          ],
        ]
      : [],
  );
  const providerApps = new ProviderAppsService(fromFile, test.store.config, registry);
  let nowMs = test.clock.now().getTime();
  const sessions = new MemorySessionStore(() => nowMs);
  const audit = new MemoryAuditWriter();
  const logs: string[] = [];
  const fetch: MockFetch = mockFetch(options.routes ?? [conversion()]);
  const service = new AppRegistrationService({
    registry,
    providerApps,
    sessions,
    publicUrl: PUBLIC_URL,
    callbackUrl: (id) => new URL(`/connections/callback/${id}`, PUBLIC_URL),
    audit,
    fetch,
    clock: test.clock,
    logger: createLogger({
      level: 'debug',
      redact: (t) => t,
      write: (_l, line) => logs.push(line),
    }),
  });
  const advance = (ms: number) => {
    nowMs += ms;
    test.clock.advance(ms);
  };
  return { ...test, service, providerApps, audit, logs, fetch, advance };
}

const CHOICE = {
  ownerKind: 'organization',
  ownerLogin: 'vaubaan',
  name: 'Vaubaan gateway.acme.test',
  permissions: defaultPermissionChoice(
    githubPlugin.credential.kind === 'app-install'
      ? (githubPlugin.credential.manifestRegistration?.permissions ?? [])
      : [],
  ),
};

function returnQuery(state: string, code: string | null = CODE): URLSearchParams {
  const query = new URLSearchParams({ state });
  if (code !== null) query.set('code', code);
  return query;
}

async function codeOf(run: Promise<unknown>): Promise<RegistrationErrorCode> {
  try {
    await run;
  } catch (err) {
    if (err instanceof AppRegistrationError) return err.code;
    throw err;
  }
  throw new Error('expected an AppRegistrationError');
}

describe('starting the creation', () => {
  it('builds the manifest on the public URL with the chosen permissions', async () => {
    const { service } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    const view = await service.pending(SESSION, 'github', state);
    expect(view?.action).toBe(
      `https://github.com/organizations/vaubaan/settings/apps/new?state=${state}`,
    );
    expect(view?.manifestField).toBe('manifest');
    expect(JSON.parse(view!.manifest)).toEqual({
      name: 'Vaubaan gateway.acme.test',
      url: 'https://gateway.acme.test/',
      description: expect.any(String) as unknown,
      redirect_url: `https://gateway.acme.test${registrationReturnPath('github')}`,
      callback_urls: ['https://gateway.acme.test/connections/callback/github'],
      request_oauth_on_install: true,
      public: false,
      default_permissions: CHOICE.permissions,
    });
  });

  it('sends exactly the permissions kept, metadata always, to the personal account', async () => {
    const { service } = setup();
    const { state } = await service.start(ACTOR, 'github', {
      ...CHOICE,
      ownerKind: 'personal',
      permissions: { contents: 'read', workflows: 'none', administration: 'none' },
    });
    const view = await service.pending(SESSION, 'github', state);
    expect(view?.action).toBe(`https://github.com/settings/apps/new?state=${state}`);
    const sent = JSON.parse(view!.manifest) as { default_permissions: unknown };
    expect(sent.default_permissions).toEqual({
      metadata: 'read',
      contents: 'read',
    });
    expect(view?.permissions).toEqual({ metadata: 'read', contents: 'read' });
  });

  it('refuses a malformed owner, an empty or long name, an unknown permission', async () => {
    const { service } = setup();
    const err = await service
      .start(ACTOR, 'github', {
        ownerKind: 'organization',
        ownerLogin: 'acme/../x',
        name: 'x'.repeat(35),
        permissions: { secrets: 'write' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppRegistrationError);
    const { code, problems } = err as AppRegistrationError;
    expect(code).toBe('invalid-choice');
    expect(problems.join(' ')).toMatch(/not an organisation name/);
    expect(problems.join(' ')).toMatch(/longer than 34/);
    expect(problems.join(' ')).toMatch(/'secrets' is not a permission/);
    expect(await codeOf(service.start(ACTOR, 'github', { ...CHOICE, ownerKind: 'nobody' }))).toBe(
      'invalid-choice',
    );
    expect(await codeOf(service.start(ACTOR, 'github', { ...CHOICE, name: '  ' }))).toBe(
      'invalid-choice',
    );
  });

  it('is refused when the configuration file sets the app, read-only as the form', async () => {
    const { service } = setup({ fromFile: true });
    expect(await service.availability('github')).toBe('read-only');
    expect(await codeOf(service.start(ACTOR, 'github', CHOICE))).toBe('read-only');
  });

  it('is refused when an app is already stored: replacing one is the form’s job', async () => {
    const { service, store } = setup();
    await store.config.set(providerAppKey('github', 'app_slug'), 'existing-app');
    expect(await service.availability('github')).toBe('already-set');
    expect(await codeOf(service.start(ACTOR, 'github', CHOICE))).toBe('already-set');
  });

  it('is not offered for a service whose app is entered by hand only', async () => {
    const { service } = setup();
    expect(service.manifestOf('appco')).toBeNull();
    expect(await service.availability('appco')).toBe('not-supported');
    expect(await codeOf(service.start(ACTOR, 'appco', CHOICE))).toBe('not-supported');
  });

  it('defaults the name to one naming the instance, within the service’s limit', () => {
    const { service } = setup();
    expect(service.defaultName('github')).toBe('Vaubaan gateway.acme.test');
  });
});

describe('the state', () => {
  it('is read back by the session that started the flow only', async () => {
    const { service } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    expect(await service.pending('another-session', 'github', state)).toBeNull();
    expect(await service.pending(SESSION, 'appco', state)).toBeNull();
    expect(await service.pending(SESSION, 'github', 'forged')).toBeNull();
    expect(await service.pending(SESSION, 'github', state)).not.toBeNull();
  });

  it('is single use: a replayed return finds nothing and exchanges nothing', async () => {
    const { service, fetch } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    await service.complete(SESSION, 'github', returnQuery(state));
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state)))).toBe(
      'state-invalid',
    );
    expect(fetch.calls).toHaveLength(1);
  });

  it('expires', async () => {
    const { service, fetch, advance } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    advance(REGISTRATION_TTL_MS + 1000);
    expect(await service.pending(SESSION, 'github', state)).toBeNull();
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state)))).toBe(
      'state-invalid',
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('is bound to the session: a return in another session is refused and burns it', async () => {
    const { service, fetch } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    expect(await codeOf(service.complete('another-session', 'github', returnQuery(state)))).toBe(
      'state-invalid',
    );
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state)))).toBe(
      'state-invalid',
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('a missing or forged state exchanges nothing', async () => {
    const { service, fetch } = setup();
    expect(await codeOf(service.complete(SESSION, 'github', new URLSearchParams()))).toBe(
      'state-invalid',
    );
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery('x'.repeat(43))))).toBe(
      'state-invalid',
    );
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('the return', () => {
  it('exchanges the code once and stores the app where the form would, secrets sealed', async () => {
    const { service, providerApps, store, fetch } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    const record = await service.complete(SESSION, 'github', returnQuery(state));

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.method).toBe('POST');
    expect(fetch.calls[0]!.url).toBe(CONVERSION);
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined();

    const status = await providerApps.status('github');
    expect(status.source).toBe('store');
    expect(status.configured).toBe(true);
    expect(status.values).toEqual({
      app_id: '424242',
      app_slug: 'vaubaan-gateway-acme-test',
      client_id: 'Iv23liAcme',
    });
    expect([...status.secretsSet].sort()).toEqual(['client_secret', 'private_key']);
    // The host's own flows read them back; the plugin never gets the client secret.
    const host = await providerApps.hostAppConfig('github');
    expect(host.private_key).toBe(PEM);
    expect(host.client_secret).toBe(CLIENT_SECRET);
    expect(await providerApps.pluginAppConfig('github')).not.toHaveProperty('client_secret');
    // Sealed: the plain secrets are not in the stored values.
    expect(await store.config.get(providerAppKey('github', 'private_key'))).not.toBe(PEM);
    expect(await store.config.get(providerAppKey('github', 'client_secret'))).not.toBe(
      CLIENT_SECRET,
    );
    // The webhook secret is not kept: the gateway receives no webhook.
    const everything = await Promise.all(
      (await store.config.keys()).map((key) => store.config.get(key)),
    );
    expect(everything.join(' ')).not.toContain(WEBHOOK_SECRET);

    expect(record).toMatchObject({
      name: 'Vaubaan gateway.acme.test',
      slug: 'vaubaan-gateway-acme-test',
      ownerLogin: 'vaubaan',
      ownerKind: 'organization',
      htmlUrl: 'https://github.com/apps/vaubaan-gateway-acme-test',
      permissions: { metadata: 'read', contents: 'read' },
      createdBy: 'user-ops',
    });
    expect(await providerApps.registration('github')).toEqual(record);
    expect(JSON.stringify(record)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(record)).not.toContain('BEGIN RSA');
  });

  it('audits who created which app and what it asked, never a secret', async () => {
    const { service, audit, logs } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    await service.complete(SESSION, 'github', returnQuery(state));
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0] as AdminAuditEntry;
    expect(entry).toMatchObject({
      kind: 'admin',
      user_id: 'user-ops',
      act: 'config-changed',
      object: { type: 'instance-config', id: 'provider-app:github' },
      before: { source: 'none' },
      after: {
        source: 'store',
        values: { app_id: '424242', app_slug: 'vaubaan-gateway-acme-test' },
        created_from: 'manifest',
        app_name: 'Vaubaan gateway.acme.test',
        owner: 'vaubaan',
        permissions_requested: CHOICE.permissions,
      },
    });
    const written = JSON.stringify(entry) + logs.join('');
    for (const secret of [CLIENT_SECRET, WEBHOOK_SECRET, 'MIIEsecretkeymaterial', CODE]) {
      expect(written).not.toContain(secret);
    }
  });

  it('a cancelled creation (no code) stores nothing and exchanges nothing', async () => {
    const { service, providerApps, fetch } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state, null)))).toBe(
      'cancelled',
    );
    expect(fetch.calls).toHaveLength(0);
    expect((await providerApps.status('github')).source).toBe('none');
  });

  it('a malformed code never reaches a URL', async () => {
    const { service, fetch } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state, '../../x')))).toBe(
      'code-invalid',
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it.each([
    ['an expired or used code', conversion({ status: 404, body: { message: 'Not Found' } })],
    ['a refusal', conversion({ status: 422, body: { message: 'Validation Failed' } })],
  ])('%s stores nothing and says so', async (_label, route) => {
    const { service, providerApps, audit } = setup({ routes: [route] });
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    const err = (await service
      .complete(SESSION, 'github', returnQuery(state))
      .catch((e: unknown) => e)) as AppRegistrationError;
    expect(err.code).toBe('exchange-refused');
    expect(err.problems.join(' ')).toMatch(/answered \d{3}/);
    expect((await providerApps.status('github')).source).toBe('none');
    expect(audit.entries).toHaveLength(0);
  });

  it('a service that cannot be reached stores nothing', async () => {
    const { service, providerApps } = setup({ routes: [] });
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state)))).toBe(
      'exchange-failed',
    );
    expect((await providerApps.status('github')).source).toBe('none');
  });

  it.each([
    ['not JSON', 'not json'],
    ['without a private key', { ...ANSWER, pem: undefined }],
    ['without a client secret', { ...ANSWER, client_secret: null }],
  ])('an answer %s stores nothing', async (_label, body) => {
    const { service, providerApps } = setup({ routes: [conversion({ body })] });
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state)))).toBe(
      'answer-unreadable',
    );
    expect((await providerApps.status('github')).source).toBe('none');
  });

  it('is refused if an app was entered by hand meanwhile, before any exchange', async () => {
    const { service, store, fetch } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    await store.config.set(providerAppKey('github', 'app_id'), '7');
    expect(await codeOf(service.complete(SESSION, 'github', returnQuery(state)))).toBe(
      'already-set',
    );
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('what the page shows afterwards', () => {
  it('describes the app until its settings are replaced by hand, and goes with them', async () => {
    const { service, providerApps, store } = setup();
    const { state } = await service.start(ACTOR, 'github', CHOICE);
    await service.complete(SESSION, 'github', returnQuery(state));
    expect(await providerApps.registration('github')).not.toBeNull();

    await providerApps.save('github', { app_id: '999', app_slug: 'another', client_id: 'other' });
    expect(await providerApps.registration('github')).toBeNull();

    await providerApps.clear('github');
    expect(await store.config.get(registrationKey('github'))).toBeNull();
  });

  it('saving a created app twice is refused', async () => {
    const { providerApps } = setup();
    const record = {
      name: 'n',
      slug: 's',
      ownerLogin: 'o',
      ownerKind: 'personal' as const,
      htmlUrl: 'https://github.com/apps/s',
      permissions: {},
      createdBy: 'u',
      createdAt: '2026-10-14T00:00:00.000Z',
    };
    const config = {
      app_id: '1',
      app_slug: 's',
      private_key: PEM,
      client_id: 'c',
      client_secret: 'x',
    };
    await providerApps.saveRegistered('github', config, record);
    await expect(providerApps.saveRegistered('github', config, record)).rejects.toThrow(
      /already has a company app/,
    );
  });
});
