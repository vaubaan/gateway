import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SignInProvider } from '../config/sign-in';
import type { AdminRule } from '../config/types';
import { openTestStore, type TestStore } from '../store/testing';
import {
  setUpElsewhere,
  SignInProvidersService,
  type SignInProviderInput,
} from './sign-in-providers';

const CLOCK = { now: () => new Date('2026-10-14T10:00:00Z') };
const PUBLIC_URL = new URL('https://gateway.test');
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
      file?: { signIn?: SignInProvider[] };
      rule?: AdminRule;
    } = {},
  ): SignInProvidersService {
    return new SignInProvidersService(
      { signIn: options.file?.signIn ?? [], publicUrl: PUBLIC_URL },
      async () => (options.rule?.group ? [options.rule.group] : []),
      t.store.config,
      CLOCK,
    );
  }

  it('records the address a provider was set up for, and a passed test moves it', async () => {
    const s = service();
    await s.save(GITHUB, 'create');
    expect((await s.state('github')).registeredFor).toBe('https://gateway.test');
    expect(setUpElsewhere((await s.views())[0]!, PUBLIC_URL)).toBeNull();
    // The same store under another address: a restore on a new host.
    const moved = new SignInProvidersService(
      { signIn: [], publicUrl: new URL('https://restored.example') },
      async () => [],
      t.store.config,
      CLOCK,
    );
    const view = (await moved.views())[0]!;
    expect(view.registeredFor).toBe('https://gateway.test');
    expect(setUpElsewhere(view, new URL('https://restored.example'))).toBe('gateway.test');
    // A failed test changes nothing; a passed one proves the callback works here.
    const base = { at: '2026-10-23T10:00:00Z', by: 'user:ops', sessionId: 's1' };
    await moved.recordTest('github', { ...base, outcome: 'failed', error: 'idp-error' });
    expect((await moved.state('github')).registeredFor).toBe('https://gateway.test');
    await moved.recordTest('github', { ...base, outcome: 'passed' });
    expect((await moved.state('github')).registeredFor).toBe('https://restored.example');
    expect(
      setUpElsewhere((await moved.views())[0]!, new URL('https://restored.example')),
    ).toBeNull();
    // Local accounts are set up nowhere.
    await s.save({ ...GITHUB, id: 'local', kind: 'local', name: 'Local' }, 'create');
    expect((await s.state('local')).registeredFor).toBeNull();
  });

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
    const resolved = (await s.resolve('github'))?.provider;
    expect(resolved?.kind === 'github' ? resolved.clientSecret : null).toBe('github-secret');
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

  it('saves a provider named idp like any other: its settings and its sealed secret', async () => {
    const s = service();
    await s.save({ ...COMPANY, id: 'idp' }, 'create');
    expect(await t.store.config.get('idp.issuer')).toBeNull();
    expect(await t.store.config.getSecret('sign_in.idp.client_secret')).toBe('company-secret');
    expect((await s.views()).map((p) => p.id)).toEqual(['idp']);
    await s.remove('idp');
    expect(await t.store.config.get('sign_in.idp')).toBeNull();
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
      problems: [expect.stringContaining('does not say which provider claims it')],
    });
    // Named with its provider, the rule allows both.
    const named = service({ rule: { group: 'company:gateway-admins', emails: [] } });
    await expect(named.save(GITHUB, 'create')).resolves.toMatchObject({
      saved: { id: 'github' },
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

describe('SignInProvidersService — what an OpenID Connect issuer must be', () => {
  let t: TestStore;
  let checked: string[];
  let answer: string | null;
  beforeEach(() => {
    t = openTestStore();
    checked = [];
    answer = null;
  });
  afterEach(() => t.store.close());

  function service(): SignInProvidersService {
    return new SignInProvidersService(
      { signIn: [], publicUrl: PUBLIC_URL },
      async () => [],
      t.store.config,
      CLOCK,
      {
        checkIssuer: (issuer) => {
          checked.push(issuer.href);
          return Promise.resolve(answer);
        },
      },
    );
  }

  it('refuses github.com as an OpenID Connect issuer, saying which kind to choose, before any discovery', async () => {
    const s = service();
    for (const issuer of [
      'https://github.com',
      'https://github.com/login/oauth',
      'https://www.github.com',
    ]) {
      await expect(
        s.save({ ...COMPANY, id: 'gh', issuer, invitationOnly: true }, 'create'),
      ).rejects.toMatchObject({
        problems: expect.arrayContaining([
          'GitHub is not an OpenID Connect provider: choose the GitHub kind',
        ]) as unknown,
      });
    }
    expect(checked).toEqual([]);
    expect(await s.views()).toEqual([]);
    // The GitHub kind is the way out.
    await expect(s.save(GITHUB, 'create')).resolves.toMatchObject({ saved: { kind: 'github' } });
    const resolved = (await s.resolve('github'))?.provider;
    expect(resolved).toMatchObject({
      kind: 'github',
      issuer: new URL('https://github.com'),
      clientSecret: 'github-secret',
    });
    // An edit of the GitHub provider is unchanged too, and never checks discovery.
    await s.save({ ...GITHUB, name: 'GitHub (Acme)', clientSecret: null }, 'update');
    expect((await s.view('github'))?.name).toBe('GitHub (Acme)');
    expect(checked).toEqual([]);
  });

  it('checks the discovery document of a new issuer and refuses with its problem', async () => {
    const s = service();
    answer =
      'there is no OpenID Connect discovery document at https://login.example.com/realms/acme/.well-known/openid-configuration (HTTP 404): check the issuer';
    await expect(s.save(COMPANY, 'create')).rejects.toMatchObject({ problems: [answer] });
    expect(checked).toEqual(['https://login.example.com/realms/acme']);
    expect(await s.views()).toEqual([]);
    answer = null;
    await expect(s.save(COMPANY, 'create')).resolves.toMatchObject({ saved: { id: 'company' } });
  });

  it('checks again only when the issuer changes', async () => {
    const s = service();
    await s.save(COMPANY, 'create');
    checked = [];
    await s.save({ ...COMPANY, name: 'Acme SSO', clientSecret: null }, 'update');
    expect(checked).toEqual([]);
    answer = 'refused';
    await expect(
      s.save({ ...COMPANY, issuer: 'https://login.example.com/realms/other' }, 'update'),
    ).rejects.toMatchObject({ problems: ['refused'] });
    expect(checked).toEqual(['https://login.example.com/realms/other']);
  });

  it('does not check while the form has other problems', async () => {
    const s = service();
    await expect(s.save({ ...COMPANY, clientId: '' }, 'create')).rejects.toMatchObject({
      problems: ['client id is required'],
    });
    expect(checked).toEqual([]);
  });
});
