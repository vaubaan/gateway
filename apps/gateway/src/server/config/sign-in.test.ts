import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import { loadInstanceConfig } from './load';
import {
  admissionProblem,
  adminGroupProblem,
  admitsEveryone,
  fileSignInProviders,
  githubApiBase,
  isOpenProvider,
  isSignInProviderId,
  issuerKey,
  reservedGroupNames,
  resolveAdminGroup,
} from './sign-in';
import { parseSignInEnvName } from './sources';
import { fakeFiles, TEST_BOOTSTRAP_TOKEN, validEnv } from './testing';

const IDP_ENV = {
  VAUBAAN_IDP_ISSUER: 'https://login.example.com/realms/acme',
  VAUBAAN_IDP_CLIENT_ID: 'vaubaan-gateway',
  VAUBAAN_IDP_CLIENT_SECRET: 'idp-secret-value',
};
const GITHUB_ENV = {
  VAUBAAN_SIGN_IN_GITHUB_KIND: 'github',
  VAUBAAN_SIGN_IN_GITHUB_CLIENT_ID: 'Ov23liExample',
  VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET: 'github-secret-value',
  VAUBAAN_SIGN_IN_GITHUB_INVITATION_ONLY: 'true',
};

function failure(
  env: Record<string, string | undefined>,
  files?: Record<string, string>,
): ConfigError {
  try {
    loadInstanceConfig({ env: validEnv(env), readFile: files ? fakeFiles(files) : undefined });
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('the configuration loaded');
}

function messages(err: ConfigError): string {
  return err.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
}

describe('sign-in providers in the configuration', () => {
  it('keeps the single idp.* keys working as the provider idp', () => {
    const { config } = loadInstanceConfig({ env: validEnv(IDP_ENV) });
    expect(fileSignInProviders(config)).toEqual([
      expect.objectContaining({
        id: 'idp',
        kind: 'oidc',
        name: 'login.example.com',
        allowedEmailDomains: [],
        invitationOnly: false,
      }),
    ]);
    expect(config.signIn).toEqual([]);
  });

  it('reads a GitHub provider from the environment, with github.com as its issuer', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ ...GITHUB_ENV, VAUBAAN_BOOTSTRAP_TOKEN: undefined }),
    });
    expect(config.signIn).toEqual([
      {
        kind: 'github',
        id: 'github',
        name: 'GitHub',
        issuer: new URL('https://github.com'),
        clientId: 'Ov23liExample',
        clientSecret: 'github-secret-value',
        allowedEmailDomains: [],
        invitationOnly: true,
      },
    ]);
    // A provider in the configuration makes the bootstrap token optional.
    expect(config.bootstrapToken).toBeNull();
  });

  it('reads several providers from the file next to the idp.* keys, and the secret by reference', () => {
    const yaml = [
      'sign_in:',
      '  partners:',
      '    kind: oidc',
      '    name: Partners',
      '    issuer: https://partners.example.org',
      '    client_id: p',
      '    client_secret: ${file:/run/secrets/p}',
      '    allowed_email_domains: [Partner.Example.org]',
      '  github:',
      '    kind: github',
      '    client_id: g',
      '    client_secret: s',
      '    allowed_email_domains: [example.com]',
    ].join('\n');
    const { config } = loadInstanceConfig({
      env: validEnv({ ...IDP_ENV, VAUBAAN_CONFIG_FILE: '/c.yaml', VAUBAAN_ADMIN_GROUP: 'idp:ops' }),
      readFile: fakeFiles({ '/c.yaml': yaml, '/run/secrets/p': 'partner-secret\n' }),
    });
    expect(fileSignInProviders(config).map((p) => p.id)).toEqual(['idp', 'partners', 'github']);
    const partners = config.signIn[0];
    expect(partners).toMatchObject({
      clientSecret: 'partner-secret',
      allowedEmailDomains: ['partner.example.org'],
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
    });
  });

  it('refuses an open provider with neither allowed domains nor invitation only, saying why', () => {
    const err = failure({ ...GITHUB_ENV, VAUBAAN_SIGN_IN_GITHUB_INVITATION_ONLY: undefined });
    expect(messages(err)).toMatch(
      /sign_in\.github\.allowed_email_domains: anyone can hold an account at https:\/\/github\.com.*needs an admission rule/,
    );
    expect(err.issues[0]?.env).toContain('VAUBAAN_SIGN_IN_GITHUB_INVITATION_ONLY');
  });

  it('refuses the single idp.* keys pointing at personal Google accounts without a rule', () => {
    const err = failure({ ...IDP_ENV, VAUBAAN_IDP_ISSUER: 'https://accounts.google.com' });
    expect(messages(err)).toMatch(/idp\.allowed_email_domains: anyone can hold an account/);
    // With a rule, it loads.
    loadInstanceConfig({
      env: validEnv({
        ...IDP_ENV,
        VAUBAAN_IDP_ISSUER: 'https://accounts.google.com',
        VAUBAAN_IDP_INVITATION_ONLY: 'true',
      }),
    });
  });

  it('refuses invitation only together with allowed domains', () => {
    const err = failure({
      ...GITHUB_ENV,
      VAUBAAN_SIGN_IN_GITHUB_ALLOWED_EMAIL_DOMAINS: 'example.com',
    });
    expect(messages(err)).toMatch(/choose one/);
  });

  it('refuses a bare admin group once several providers are configured', () => {
    const err = failure({ ...IDP_ENV, ...GITHUB_ENV, VAUBAAN_ADMIN_GROUP: 'gateway-admins' });
    expect(messages(err)).toMatch(/admin\.group: .*write it as "<provider>:<group>"/);
    loadInstanceConfig({
      env: validEnv({ ...IDP_ENV, ...GITHUB_ENV, VAUBAAN_ADMIN_GROUP: 'github:acme/admins' }),
    });
  });

  it('refuses two providers of one issuer, a bad id, a bad kind and claims on GitHub', () => {
    expect(
      messages(
        failure({
          ...IDP_ENV,
          VAUBAAN_SIGN_IN_TWIN_KIND: 'oidc',
          VAUBAAN_SIGN_IN_TWIN_ISSUER: 'https://login.example.com/realms/acme/',
          VAUBAAN_SIGN_IN_TWIN_CLIENT_ID: 'x',
          VAUBAAN_SIGN_IN_TWIN_CLIENT_SECRET: 'y',
          VAUBAAN_ADMIN_GROUP: undefined,
        }),
      ),
    ).toMatch(/same issuer/);
    expect(
      messages(
        failure({
          VAUBAAN_SIGN_IN_X_KIND: 'saml',
          VAUBAAN_SIGN_IN_X_CLIENT_ID: 'x',
          VAUBAAN_SIGN_IN_X_CLIENT_SECRET: 'y',
        }),
      ),
    ).toMatch(/sign_in\.x\.kind: expected one of oidc, github/);
    expect(messages(failure({ ...GITHUB_ENV, VAUBAAN_SIGN_IN_GITHUB_CLAIM_SUB: 'login' }))).toMatch(
      /has no claim mapping/,
    );
    const yaml = 'sign_in:\n  Bad_Id:\n    kind: oidc\n';
    expect(messages(failure({ VAUBAAN_CONFIG_FILE: '/c.yaml' }, { '/c.yaml': yaml }))).toMatch(
      /sign_in\.Bad_Id: a sign-in provider id/,
    );
  });

  it('requires https for every provider issuer', () => {
    expect(
      messages(
        failure({
          VAUBAAN_SIGN_IN_ACME_KIND: 'oidc',
          VAUBAAN_SIGN_IN_ACME_ISSUER: 'http://login.example.com',
          VAUBAAN_SIGN_IN_ACME_CLIENT_ID: 'x',
          VAUBAAN_SIGN_IN_ACME_CLIENT_SECRET: 'y',
        }),
      ),
    ).toMatch(/sign_in\.acme\.issuer: must use https/);
  });

  it('keeps the bootstrap token required while no provider is configured', () => {
    expect(messages(failure({ VAUBAAN_BOOTSTRAP_TOKEN: undefined }))).toMatch(
      /bootstrap_token: missing required key/,
    );
    expect(TEST_BOOTSTRAP_TOKEN.length).toBeGreaterThan(31);
  });

  it('parses provider ids with hyphens and the _FILE form of the secret', () => {
    expect(parseSignInEnvName('VAUBAAN_SIGN_IN_ACME_ENTRA_CLIENT_ID')).toMatchObject({
      providerId: 'acme-entra',
      spec: { field: 'client_id' },
    });
    expect(parseSignInEnvName('VAUBAAN_SIGN_IN_CLIENT_ID')).toBeNull();
    const { config } = loadInstanceConfig({
      env: validEnv({
        ...GITHUB_ENV,
        VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET: undefined,
        VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET_FILE: '/run/secrets/g',
      }),
      readFile: fakeFiles({ '/run/secrets/g': 'from-file\n' }),
    });
    expect(config.signIn[0]?.clientSecret).toBe('from-file');
  });
});

describe('sign-in helpers', () => {
  const at = (issuer: string) => ({ kind: 'oidc' as const, issuer: new URL(issuer) });

  it('knows which providers anyone can hold an account at', () => {
    expect(isOpenProvider({ kind: 'github', issuer: new URL('https://github.com') })).toBe(true);
    expect(isOpenProvider({ kind: 'github', issuer: new URL('https://ghe.example.com') })).toBe(
      true,
    );
    expect(isOpenProvider(at('https://accounts.google.com'))).toBe(true);
    expect(isOpenProvider(at('https://accounts.google.com/'))).toBe(true);
    expect(isOpenProvider(at('https://login.microsoftonline.com/common/v2.0'))).toBe(true);
    expect(
      isOpenProvider(
        at('https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0'),
      ),
    ).toBe(true);
    expect(isOpenProvider(at('https://login.microsoftonline.com/11111111-2222/v2.0'))).toBe(false);
    expect(isOpenProvider(at('https://keycloak.example.com/realms/acme'))).toBe(false);
  });

  it('admits everyone only for a directory with no domain and not invitation only', () => {
    const base = { allowedEmailDomains: [] as string[], invitationOnly: false };
    expect(admitsEveryone({ ...at('https://kc.example.com'), ...base })).toBe(true);
    expect(admitsEveryone({ ...at('https://accounts.google.com'), ...base })).toBe(false);
    expect(admitsEveryone({ ...at('https://kc.example.com'), ...base, invitationOnly: true })).toBe(
      false,
    );
    expect(admissionProblem({ id: 'g', ...at('https://accounts.google.com'), ...base })).toMatch(
      /needs an admission rule/,
    );
    expect(
      admissionProblem({
        id: 'g',
        ...at('https://accounts.google.com'),
        allowedEmailDomains: ['example.com'],
        invitationOnly: false,
      }),
    ).toBeNull();
  });

  it('resolves the admin group against the providers configured now', () => {
    expect(resolveAdminGroup('admins', ['idp'])).toEqual({ provider: 'idp', name: 'admins' });
    expect(resolveAdminGroup('admins', ['idp', 'github'])).toBeNull();
    expect(resolveAdminGroup('github:acme/a', ['idp', 'github'])).toEqual({
      provider: 'github',
      name: 'acme/a',
    });
    expect(resolveAdminGroup('github:acme/a', ['company'])).toBeNull();
    expect(adminGroupProblem('admins', ['a', 'b'])).toMatch(/"a:admins"/);
    expect(adminGroupProblem('admins', [])).toBeNull();
    expect(reservedGroupNames('github:acme/a')).toEqual(['github:acme/a', 'acme/a']);
  });

  it('normalises issuers and derives the GitHub API', () => {
    expect(issuerKey('https://idp.example.com/')).toBe('https://idp.example.com');
    expect(githubApiBase(new URL('https://github.com')).href).toBe('https://api.github.com/');
    expect(githubApiBase(new URL('https://ghe.example.com/')).href).toBe(
      'https://ghe.example.com/api/v3',
    );
    expect(isSignInProviderId('acme-entra')).toBe(true);
    expect(isSignInProviderId('Acme')).toBe(false);
    expect(isSignInProviderId('1x')).toBe(false);
  });
});
