import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SignInProvider } from '../config/sign-in';
import type { AdminRule, IdpConfig } from '../config/types';
import { openTestStore, type TestStore } from '../store/testing';
import { IdpSettingsService } from './idp-settings';
import { SignInProvidersService, type SignInProviderInput } from './sign-in-providers';

const CLOCK = { now: () => new Date('2026-10-14T10:00:00Z') };
const GITHUB: SignInProviderInput = {
  id: 'github',
  kind: 'github',
  name: '',
  issuer: '',
  clientId: 'Ov23liExample',
  clientSecret: 'github-secret',
  allowedEmailDomains: [],
  invitationOnly: true,
};
const COMPANY: SignInProviderInput = {
  id: 'company',
  kind: 'oidc',
  name: 'Acme',
  issuer: 'https://login.example.com/realms/acme',
  clientId: 'vaubaan',
  clientSecret: 'company-secret',
  claims: { sub: 'sub', email: 'email', groups: 'groups' },
  allowedEmailDomains: [],
  invitationOnly: false,
};

describe('SignInProvidersService', () => {
  let t: TestStore;
  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  function service(
    options: {
      file?: { idp?: IdpConfig | null; signIn?: SignInProvider[] };
      rule?: AdminRule;
    } = {},
  ): SignInProvidersService {
    const idp = options.file?.idp ?? null;
    const legacy = new IdpSettingsService(idp, t.store.config);
    return new SignInProvidersService(
      { idp, signIn: options.file?.signIn ?? [] },
      options.rule ?? { group: null, emails: ['ops@example.com'] },
      legacy,
      t.store.config,
      CLOCK,
    );
  }

  it('saves a GitHub provider with github.com as issuer, its secret sealed and never in a view', async () => {
    const s = service();
    const { saved } = await s.save(GITHUB, 'create');
    expect(saved).toMatchObject({
      id: 'github',
      name: 'GitHub',
      issuer: new URL('https://github.com'),
    });
    const views = await s.views();
    expect(views).toHaveLength(1);
    expect(JSON.stringify(views)).not.toContain('github-secret');
    expect(views[0]).not.toHaveProperty('clientSecret');
    expect((await s.resolve('github'))?.provider.clientSecret).toBe('github-secret');
    const row = t.store.db
      .prepare<[string], { value: string | null; secret_blob: Buffer | null }>(
        'SELECT value, secret_blob FROM instance_config WHERE key = ?',
      )
      .get('sign_in.github.client_secret');
    // Held as a sealed column (the test store's encryptor is a stand-in), never as a value.
    expect(row?.value).toBeNull();
    expect(row?.secret_blob).not.toBeNull();
    expect(await t.store.config.get('sign_in.github')).not.toContain('github-secret');
  });

  it('keeps the stored secret on a blank field for the same issuer, and asks again when it changes', async () => {
    const s = service();
    await s.save(COMPANY, 'create');
    await s.save({ ...COMPANY, name: 'Acme corp', clientSecret: null }, 'update');
    expect((await s.resolve('company'))?.provider).toMatchObject({
      name: 'Acme corp',
      clientSecret: 'company-secret',
    });
    await expect(
      s.save({ ...COMPANY, issuer: 'https://other.example.com', clientSecret: null }, 'update'),
    ).rejects.toMatchObject({ problems: [expect.stringContaining('issuer changes')] });
  });

  it('saves the provider idp under the single-provider keys, which earlier versions read', async () => {
    const s = service();
    await s.save({ ...COMPANY, id: 'idp' }, 'create');
    expect(await t.store.config.get('idp.issuer')).toBe('https://login.example.com/realms/acme');
    expect((await s.views()).map((p) => p.id)).toEqual(['idp']);
    await s.remove('idp');
    expect(await t.store.config.get('idp.issuer')).toBeNull();
  });

  it('shows a provider of the file read-only and refuses to change or remove it', async () => {
    const file: SignInProvider = {
      kind: 'github',
      id: 'github',
      name: 'GitHub',
      issuer: new URL('https://github.com'),
      clientId: 'x',
      clientSecret: 'from-file',
      allowedEmailDomains: [],
      invitationOnly: true,
    };
    const s = service({ file: { signIn: [file] } });
    expect(await s.views()).toEqual([expect.objectContaining({ id: 'github', source: 'file' })]);
    await expect(s.save(GITHUB, 'update')).rejects.toMatchObject({
      problems: [expect.stringContaining('mounted configuration')],
    });
    await expect(s.remove('github')).rejects.toMatchObject({
      problems: [expect.stringContaining('mounted configuration')],
    });
  });

  it('refuses a second provider that would make a bare admin group ambiguous', async () => {
    const s = service({ rule: { group: 'gateway-admins', emails: [] } });
    await s.save(COMPANY, 'create');
    await expect(s.save(GITHUB, 'create')).rejects.toMatchObject({
      problems: [expect.stringContaining('<provider>:<group>')],
    });
    // Named with its provider, the rule allows both.
    const named = service({ rule: { group: 'company:gateway-admins', emails: [] } });
    await named.save(GITHUB, 'create');
    expect((await named.adminRule()).group).toEqual({
      provider: 'company',
      name: 'gateway-admins',
    });
  });

  it('refuses a bad id, a duplicate id, a change of kind and an open provider without a rule', async () => {
    const s = service();
    await expect(s.save({ ...GITHUB, id: 'Git Hub' }, 'create')).rejects.toMatchObject({
      problems: [expect.stringContaining('lower-case letter')],
    });
    await s.save(GITHUB, 'create');
    await expect(s.save(GITHUB, 'create')).rejects.toMatchObject({
      problems: [expect.stringContaining('already exists')],
    });
    await expect(s.save({ ...COMPANY, id: 'github' }, 'update')).rejects.toThrow(
      /kind of a provider cannot change/,
    );
    await expect(
      s.save(
        { ...GITHUB, id: 'gh2', issuer: 'https://ghe.example.com', invitationOnly: false },
        'create',
      ),
    ).rejects.toMatchObject({ problems: [expect.stringContaining('admission rule')] });
  });
});
