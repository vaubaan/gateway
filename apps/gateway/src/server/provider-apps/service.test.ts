import { createRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import type { ProviderAppConfig as FileProviderAppConfig } from '../config/types';
import {
  API_KEY_SPEC,
  APP_INSTALL_SPEC,
  fixturePlugin,
  OAUTH_SPEC,
  SSH_KEY_SPEC,
  UNVERIFIED_APP_INSTALL_SPEC,
} from '../connections/testing';
import { openTestStore } from '../store/testing';
import { appConfigFieldsOf, needsProviderApp } from './fields';
import {
  acceptUnverifiedKey,
  ProviderAppError,
  ProviderAppNotConfigured,
  providerAppKey,
  ProviderAppsService,
} from './service';

const PLUGINS = [
  fixturePlugin({ id: 'oauthco', displayName: 'OAuth Co', credential: OAUTH_SPEC }),
  fixturePlugin({ id: 'appco', displayName: 'App Co', credential: UNVERIFIED_APP_INSTALL_SPEC }),
  fixturePlugin({ id: 'keyco', displayName: 'Key Co', credential: API_KEY_SPEC }),
  fixturePlugin({ id: 'sshco', credential: SSH_KEY_SPEC, experimental: true }),
  fixturePlugin({ id: 'verco', displayName: 'Verified Co', credential: APP_INSTALL_SPEC }),
  fixturePlugin({
    id: 'bothco',
    displayName: 'Both Co',
    credential: OAUTH_SPEC,
    alternativeCredentials: [{ ...API_KEY_SPEC, label: 'workspace token' }],
  }),
];

function setup(fromFile: Record<string, FileProviderAppConfig> = {}) {
  const test = openTestStore();
  const service = new ProviderAppsService(
    new Map(Object.entries(fromFile)),
    test.store.config,
    createRegistry(PLUGINS),
  );
  return { ...test, service };
}

describe('fields derived from the CredentialSpec', () => {
  it('asks for client id and secret for oauth2, plus the plugin extras', () => {
    expect(appConfigFieldsOf(OAUTH_SPEC).map((f) => [f.name, f.secret])).toEqual([
      ['client_id', false],
      ['client_secret', true],
    ]);
    const extras = appConfigFieldsOf({
      ...OAUTH_SPEC,
      appConfigFields: [
        { name: 'tenant', label: 'Tenant', secret: false },
        { name: 'client_id', label: 'Duplicate', secret: false },
      ],
    });
    expect(extras.map((f) => f.name)).toEqual(['client_id', 'client_secret', 'tenant']);
  });

  it('asks for no secret for a public client and for nothing when no app exists', () => {
    expect(
      appConfigFieldsOf({ ...OAUTH_SPEC, clientAuthMethod: 'none' }).map((f) => f.name),
    ).toEqual(['client_id']);
    expect(appConfigFieldsOf(UNVERIFIED_APP_INSTALL_SPEC).map((f) => f.name)).toEqual([
      'app_id',
      'private_key',
      'app_slug',
    ]);
    // An installed app whose installations are verified also needs its OAuth client.
    expect(appConfigFieldsOf(APP_INSTALL_SPEC).map((f) => [f.name, f.secret])).toEqual([
      ['app_id', false],
      ['private_key', true],
      ['app_slug', false],
      ['client_id', false],
      ['client_secret', true],
    ]);
    expect(needsProviderApp(API_KEY_SPEC)).toBe(false);
    expect(needsProviderApp(SSH_KEY_SPEC)).toBe(false);
  });
});

describe('ProviderAppsService', () => {
  it('lists one entry per registered plugin, connectable or not', async () => {
    const { service } = setup();
    const list = await service.list();
    expect(list.map((a) => [a.providerId, a.needsApp, a.configured, a.source])).toEqual([
      ['oauthco', true, false, 'none'],
      ['appco', true, false, 'none'],
      ['keyco', false, true, 'none'],
      ['sshco', false, true, 'none'],
      ['verco', true, false, 'none'],
      ['bothco', true, false, 'none'],
    ]);
    expect(list.map((a) => a.installVerification)).toEqual([
      null,
      'unverified-refused',
      null,
      null,
      'verified',
      null,
    ]);
    expect(list[3]!.experimental).toBe(true);
    expect(list[0]!.missing).toEqual(['client_id', 'client_secret']);
  });

  it('says when a token connects the service too, making its app optional', async () => {
    const { service } = setup();
    const tokens = (await service.list()).map((a) => [a.providerId, a.token]);
    expect(tokens).toEqual([
      ['oauthco', null],
      ['appco', null],
      // A service that connects only with a key needs no app: nothing is optional.
      ['keyco', null],
      ['sshco', null],
      ['verco', null],
      ['bothco', { label: 'workspace token' }],
    ]);
  });

  it('stores the secret sealed under its own associated data and never returns it', async () => {
    const { service, store, encryptor } = setup();
    const status = await service.save('oauthco', {
      client_id: ' cid-123 ',
      client_secret: 'very-secret-value',
    });
    expect(status).toMatchObject({
      configured: true,
      source: 'store',
      values: { client_id: 'cid-123' },
      secretsSet: ['client_secret'],
      missing: [],
    });
    expect(JSON.stringify(status)).not.toContain('very-secret-value');
    expect(encryptor.sealCalls.map((c) => c.associatedData)).toEqual([
      'instance_config:provider_apps.oauthco.client_secret',
    ]);
    const row = store.db
      .prepare<[string], { value: string | null; secret_blob: Buffer | null }>(
        'SELECT value, secret_blob FROM instance_config WHERE key = ?',
      )
      .get(providerAppKey('oauthco', 'client_secret'));
    expect(row?.value).toBeNull();
    expect(row?.secret_blob).toBeInstanceOf(Buffer);
    expect(await store.config.get(providerAppKey('oauthco', 'client_id'))).toBe('cid-123');
  });

  it('keeps a stored secret when the form leaves it blank', async () => {
    const { service } = setup();
    await service.save('oauthco', { client_id: 'cid', client_secret: 'first-secret' });
    await service.save('oauthco', { client_id: 'cid-2', client_secret: '' });
    expect(await service.hostAppConfig('oauthco')).toEqual({
      client_id: 'cid-2',
      client_secret: 'first-secret',
    });
  });

  it('saves the fields of a provider in one transaction: a failed write keeps the previous app whole', async () => {
    const { service, store } = setup();
    await service.save('verco', {
      app_id: '42',
      private_key: 'PEM-1',
      app_slug: 'slug',
      client_id: 'Iv1.first',
      client_secret: 'first-secret',
    });
    const before = await service.hostAppConfig('verco');
    store.db.exec(
      `CREATE TRIGGER refuse_client_secret BEFORE INSERT ON instance_config
       WHEN NEW.key = '${providerAppKey('verco', 'client_secret')}'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    await expect(
      service.save('verco', {
        app_id: '43',
        private_key: 'PEM-2',
        app_slug: 'other',
        client_id: 'Iv1.second',
        client_secret: 'second-secret',
      }),
    ).rejects.toThrow(/disk full/);
    // Not the new app id with the old client secret, nor any other mix.
    expect(await service.hostAppConfig('verco')).toEqual(before);
  });

  it('clears a provider app in one transaction', async () => {
    const { service, store } = setup();
    await service.save('appco', { app_id: '42', private_key: 'PEM', app_slug: 'slug' });
    await service.setAcceptUnverifiedInstallations('appco', true);
    store.db.exec(
      `CREATE TRIGGER refuse_flag_removal BEFORE DELETE ON instance_config
       WHEN OLD.key = '${acceptUnverifiedKey('appco')}'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    await expect(service.clear('appco')).rejects.toThrow(/disk full/);
    expect(await service.status('appco')).toMatchObject({
      configured: true,
      installVerification: 'unverified-accepted',
    });
    store.db.exec('DROP TRIGGER refuse_flag_removal');
    await service.clear('appco');
    expect(await service.status('appco')).toMatchObject({
      source: 'none',
      installVerification: 'unverified-refused',
    });
  });

  it('reports every problem at once and writes nothing', async () => {
    const { service } = setup();
    const err = await service
      .save('appco', { app_id: 'not-a-number', private_key: '', app_slug: 'slug' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAppError);
    expect((err as ProviderAppError).problems).toEqual([
      'App ID does not have the expected format',
      'Private key (PEM) is required',
    ]);
    expect((await service.status('appco')).source).toBe('none');
    await expect(service.save('keyco', {})).rejects.toThrow(/needs no provider app/);
    expect(() => service.isReadOnly('nope')).not.toThrow();
    await expect(service.status('nope')).rejects.toThrow();
  });

  it('hands the client secret to the host only: an oauth2 plugin never receives it', async () => {
    const { service } = setup();
    await service.save('oauthco', { client_id: 'cid', client_secret: 'csecret' });
    await service.save('appco', { app_id: '42', private_key: 'PEM', app_slug: 'slug' });
    expect(await service.pluginAppConfig('oauthco')).toEqual({ client_id: 'cid' });
    // An app-install plugin mints its own tokens from the private key.
    expect(await service.pluginAppConfig('appco')).toEqual({
      app_id: '42',
      private_key: 'PEM',
      app_slug: 'slug',
    });
    expect(await service.pluginAppConfig('keyco')).toEqual({});
  });

  it('keeps the client secret of a verified app-install from its plugin too', async () => {
    const { service } = setup();
    await service.save('verco', {
      app_id: '42',
      private_key: 'PEM',
      app_slug: 'slug',
      client_id: 'Iv1.cid',
      client_secret: 'install-client-secret',
    });
    expect(await service.hostAppConfig('verco')).toMatchObject({
      client_id: 'Iv1.cid',
      client_secret: 'install-client-secret',
    });
    expect(await service.pluginAppConfig('verco')).toEqual({
      app_id: '42',
      private_key: 'PEM',
      app_slug: 'slug',
      client_id: 'Iv1.cid',
    });
  });

  it('accepts unverified installations only on an explicit operator decision', async () => {
    const { service, store } = setup({ appco: { appId: '42' } });
    expect(await service.installVerification('oauthco')).toBeNull();
    expect(await service.installVerification('verco')).toBe('verified');
    expect(await service.installVerification('appco')).toBe('unverified-refused');

    // The decision is the operator's whatever the source of the fields (here: the file).
    expect(await service.setAcceptUnverifiedInstallations('appco', true)).toMatchObject({
      installVerification: 'unverified-accepted',
      source: 'file',
    });
    expect(await store.config.get(acceptUnverifiedKey('appco'))).toBe('true');
    expect(
      (await service.setAcceptUnverifiedInstallations('appco', false)).installVerification,
    ).toBe('unverified-refused');
    expect(await store.config.get(acceptUnverifiedKey('appco'))).toBeNull();

    // The flag never weakens a verification that exists, and means nothing elsewhere.
    await expect(service.setAcceptUnverifiedInstallations('verco', true)).rejects.toThrow(
      /verifies every installation/,
    );
    await expect(service.setAcceptUnverifiedInstallations('oauthco', true)).rejects.toThrow(
      ProviderAppError,
    );
    await store.config.set(acceptUnverifiedKey('verco'), 'true');
    expect(await service.installVerification('verco')).toBe('verified');
  });

  it('names the missing fields and both places to set them', async () => {
    const { service } = setup();
    const err = await service.hostAppConfig('appco').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAppNotConfigured);
    expect((err as ProviderAppNotConfigured).missing).toEqual([
      'app_id',
      'private_key',
      'app_slug',
    ]);
    expect((err as Error).message).toContain('providers.appco.*');
    expect((err as Error).message).toContain('Admin → Provider apps');
  });

  it('lets the mounted configuration win and makes the page read-only for that provider', async () => {
    const { service } = setup({ oauthco: { clientId: 'file-cid', clientSecret: 'file-secret' } });
    // Something an operator stored earlier is ignored while the file sets the provider.
    expect(service.isReadOnly('oauthco')).toBe(true);
    expect(await service.status('oauthco')).toMatchObject({
      source: 'file',
      configured: true,
      values: { client_id: 'file-cid' },
    });
    expect(await service.hostAppConfig('oauthco')).toEqual({
      client_id: 'file-cid',
      client_secret: 'file-secret',
    });
    await expect(service.save('oauthco', { client_id: 'x', client_secret: 'y' })).rejects.toThrow(
      /set by the mounted configuration \(providers\.oauthco\.\*\)/,
    );
    expect(service.isReadOnly('appco')).toBe(false);
  });

  it('reports an incomplete file block instead of mixing it with stored values', async () => {
    const { service, store } = setup({ appco: { appId: '42' } });
    await store.config.setSecret(providerAppKey('appco', 'private_key'), 'stored-pem');
    expect(await service.status('appco')).toMatchObject({
      source: 'file',
      configured: false,
      missing: ['private_key', 'app_slug'],
    });
  });

  it('clears what the Admin page stored for one provider only', async () => {
    const { service } = setup();
    await service.save('oauthco', { client_id: 'cid', client_secret: 'csecret' });
    await service.save('appco', { app_id: '42', private_key: 'PEM', app_slug: 'slug' });
    await service.setAcceptUnverifiedInstallations('appco', true);
    await service.clear('oauthco');
    expect((await service.status('oauthco')).source).toBe('none');
    expect(await service.status('appco')).toMatchObject({
      configured: true,
      installVerification: 'unverified-accepted',
    });
    // Removing an app's settings also takes back the acceptance.
    await service.clear('appco');
    expect(await service.status('appco')).toMatchObject({
      source: 'none',
      installVerification: 'unverified-refused',
    });
  });
});
