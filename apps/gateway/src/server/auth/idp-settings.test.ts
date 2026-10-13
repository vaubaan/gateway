import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdpConfig } from '../config/types';
import { openTestStore, type TestStore } from '../store/testing';
import { IdpSettingsError } from './errors';
import {
  DEFAULT_CLAIM_MAPPING,
  IDP_CONFIG_KEYS,
  IdpSettingsService,
  splitList,
} from './idp-settings';

const INPUT = {
  issuer: 'https://login.example.com/realms/acme',
  clientId: 'vaubaan',
  clientSecret: 's3cret',
  claims: { sub: 'sub', email: 'email', groups: 'groups' },
  allowedEmailDomains: ['Example.com', 'example.com', ''],
};

describe('IdpSettingsService', () => {
  let t: TestStore;
  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  it('has no IdP until the operator saves one, then reads it back from the store', async () => {
    const s = new IdpSettingsService(null, t.store.config);
    expect(s.readOnly).toBe(false);
    expect(await s.current()).toBeNull();
    const saved = await s.save(INPUT);
    expect(saved.issuer.href).toBe('https://login.example.com/realms/acme');
    expect(saved.allowedEmailDomains).toEqual(['example.com']);
    const current = await s.current();
    expect(current?.source).toBe('store');
    expect(current?.settings).toEqual(saved);
    expect(await s.stored()).toMatchObject({ clientId: 'vaubaan', hasClientSecret: true });
    expect(await s.stored()).not.toHaveProperty('clientSecret');
  });

  it('seals the client secret (encrypted column, never the clear value)', async () => {
    const s = new IdpSettingsService(null, t.store.config);
    await s.save(INPUT);
    const row = t.store.db
      .prepare<
        [string],
        { value: string | null; secret_blob: Buffer | null }
      >('SELECT value, secret_blob FROM instance_config WHERE key = ?')
      .get(IDP_CONFIG_KEYS.clientSecret);
    expect(row?.value).toBeNull();
    expect(row?.secret_blob).not.toBeNull();
    expect(t.encryptor.sealCalls.map((c) => c.associatedData)).toContain(
      'instance_config:idp.client_secret',
    );
  });

  it('keeps the stored secret when the form leaves it blank', async () => {
    const s = new IdpSettingsService(null, t.store.config);
    await s.save(INPUT);
    const again = await s.save({ ...INPUT, clientId: 'renamed', clientSecret: null });
    expect(again.clientId).toBe('renamed');
    expect(again.clientSecret).toBe('s3cret');
  });

  it('lists every problem at once and refuses http issuers unless allowed (tests)', async () => {
    const s = new IdpSettingsService(null, t.store.config);
    await expect(
      s.save({
        ...INPUT,
        issuer: 'http://idp.test',
        clientId: ' ',
        clientSecret: '',
        claims: { sub: '', email: 'e', groups: 'g' },
        allowedEmailDomains: ['a@b'],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(IdpSettingsError);
      expect((err as IdpSettingsError).problems).toEqual([
        'issuer must use https',
        'client id is required',
        'client secret is required',
        "claim name for 'sub' is required",
        "'a@b' is not a domain name",
      ]);
      return true;
    });
    await expect(s.save({ ...INPUT, issuer: 'not a url' })).rejects.toThrow(/issuer must be a URL/);
    await expect(s.save({ ...INPUT, issuer: 'https://x.test/?q=1' })).rejects.toThrow(
      /query string/,
    );
    const lax = new IdpSettingsService(null, t.store.config, { allowInsecureIssuer: true });
    await expect(lax.save({ ...INPUT, issuer: 'http://idp.test' })).resolves.toBeDefined();
  });

  it('is read-only when the mounted configuration sets the IdP, which then wins', async () => {
    const fromFile: IdpConfig = {
      issuer: new URL('https://file.example.com'),
      clientId: 'file-client',
      clientSecret: 'file-secret',
      claims: DEFAULT_CLAIM_MAPPING,
      allowedEmailDomains: [],
    };
    const s = new IdpSettingsService(fromFile, t.store.config);
    expect(s.readOnly).toBe(true);
    expect(await s.current()).toEqual({ settings: fromFile, source: 'file' });
    await expect(s.save(INPUT)).rejects.toThrow(/mounted configuration/);
  });

  it('splits list input on whitespace, commas and newlines', () => {
    expect(splitList(' a.com, b.com\nc.com  ')).toEqual(['a.com', 'b.com', 'c.com']);
    expect(splitList('')).toEqual([]);
  });
});
