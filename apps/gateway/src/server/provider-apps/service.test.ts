import { createRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import type { ProviderAppConfig as FileProviderAppConfig } from '../config/types';
import { API_KEY_SPEC, fixturePlugin, OAUTH_SPEC, SSH_KEY_SPEC } from '../connections/testing';
import { openTestStore } from '../store/testing';
import { appConfigFieldsOf, needsProviderApp } from './fields';
import {
  ProviderAppError,
  ProviderAppNotConfigured,
  providerAppKey,
  ProviderAppsService,
} from './service';

const PLUGINS = [
  fixturePlugin({ id: 'oauthco', displayName: 'OAuth Co', credential: OAUTH_SPEC }),
  fixturePlugin({
    id: 'tenantco',
    displayName: 'Tenant Co',
    credential: {
      ...OAUTH_SPEC,
      appConfigFields: [{ name: 'tenant', label: 'Tenant', secret: false, pattern: '^[0-9]+$' }],
    },
  }),
  fixturePlugin({ id: 'keyco', displayName: 'Key Co', credential: API_KEY_SPEC }),
  fixturePlugin({ id: 'sshco', credential: SSH_KEY_SPEC, experimental: true }),
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

  it('asks for no secret for a public client and for nothing when no OAuth client exists', () => {
    expect(
      appConfigFieldsOf({ ...OAUTH_SPEC, clientAuthMethod: 'none' }).map((f) => f.name),
    ).toEqual(['client_id']);
    expect(needsProviderApp(API_KEY_SPEC)).toBe(false);
    expect(needsProviderApp(SSH_KEY_SPEC)).toBe(false);
    expect(needsProviderApp(OAUTH_SPEC)).toBe(true);
  });
});

describe('ProviderAppsService', () => {
  it('lists one entry per registered plugin, connectable or not', async () => {
    const { service } = setup();
    const list = await service.list();
    expect(list.map((a) => [a.providerId, a.needsApp, a.configured, a.source])).toEqual([
      ['oauthco', true, false, 'none'],
      ['tenantco', true, false, 'none'],
      ['keyco', false, true, 'none'],
      ['sshco', false, true, 'none'],
    ]);
    expect(list.map((a) => a.credentialKind)).toEqual(['oauth2', 'oauth2', 'api-key', 'ssh-key']);
    expect(list[3]!.experimental).toBe(true);
    expect(list[0]!.missing).toEqual(['client_id', 'client_secret']);
    expect(list[1]!.missing).toEqual(['client_id', 'client_secret', 'tenant']);
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

  it('saves the fields of a provider in one transaction: a failed write keeps the previous client whole', async () => {
    const { service, store } = setup();
    await service.save('tenantco', {
      client_id: 'Iv1.first',
      client_secret: 'first-secret',
      tenant: '42',
    });
    const before = await service.hostAppConfig('tenantco');
    store.db.exec(
      `CREATE TRIGGER refuse_client_secret BEFORE INSERT ON instance_config
       WHEN NEW.key = '${providerAppKey('tenantco', 'client_secret')}'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    await expect(
      service.save('tenantco', {
        client_id: 'Iv1.second',
        client_secret: 'second-secret',
        tenant: '43',
      }),
    ).rejects.toThrow(/disk full/);
    // Not the new tenant with the old client secret, nor any other mix.
    expect(await service.hostAppConfig('tenantco')).toEqual(before);
  });

  it('reports every problem at once and writes nothing', async () => {
    const { service } = setup();
    const err = await service
      .save('tenantco', { client_id: 'cid', client_secret: '', tenant: 'not-a-number' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAppError);
    expect((err as ProviderAppError).problems).toEqual([
      'Client secret is required',
      'Tenant does not have the expected format',
    ]);
    expect((await service.status('tenantco')).source).toBe('none');
    await expect(service.save('keyco', {})).rejects.toThrow(/needs no OAuth client/);
    expect(() => service.isReadOnly('nope')).not.toThrow();
    await expect(service.status('nope')).rejects.toThrow();
  });

  it('hands the client secret to the host only: a plugin never receives it', async () => {
    const { service } = setup();
    await service.save('oauthco', { client_id: 'cid', client_secret: 'csecret' });
    await service.save('tenantco', { client_id: 'cid', client_secret: 'csecret', tenant: '7' });
    expect(await service.pluginAppConfig('oauthco')).toEqual({ client_id: 'cid' });
    expect(await service.pluginAppConfig('tenantco')).toEqual({ client_id: 'cid', tenant: '7' });
    expect(await service.pluginAppConfig('keyco')).toEqual({});
  });

  it('names the missing fields and both places to set them', async () => {
    const { service } = setup();
    const err = await service.hostAppConfig('tenantco').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAppNotConfigured);
    expect((err as ProviderAppNotConfigured).missing).toEqual([
      'client_id',
      'client_secret',
      'tenant',
    ]);
    expect((err as Error).message).toContain('providers.tenantco.*');
    expect((err as Error).message).toContain('connect page');
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
    expect(service.isReadOnly('tenantco')).toBe(false);
  });

  it('reports an incomplete file block instead of mixing it with stored values', async () => {
    const { service, store } = setup({ oauthco: { clientId: 'file-cid' } });
    await store.config.setSecret(providerAppKey('oauthco', 'client_secret'), 'stored-secret');
    expect(await service.status('oauthco')).toMatchObject({
      source: 'file',
      configured: false,
      missing: ['client_secret'],
    });
  });

  it('clears what the page stored for one provider only', async () => {
    const { service } = setup();
    await service.save('oauthco', { client_id: 'cid', client_secret: 'csecret' });
    await service.save('tenantco', { client_id: 'cid', client_secret: 'csecret', tenant: '7' });
    await service.clear('oauthco');
    expect((await service.status('oauthco')).source).toBe('none');
    expect(await service.status('tenantco')).toMatchObject({ configured: true, source: 'store' });
    await service.clear('tenantco');
    expect(await service.status('tenantco')).toMatchObject({ source: 'none', configured: false });
  });
});
