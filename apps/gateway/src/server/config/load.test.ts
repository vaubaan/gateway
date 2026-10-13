import { describe, expect, it } from 'vitest';

import { ConfigError, formatIssue } from './errors';
import { loadInstanceConfig } from './load';
import { CONFIG_FILE_ENV } from './sources';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from './telemetry-default';
import { KEYS, parseProviderEnvName } from './sources';
import { TEST_BOOTSTRAP_TOKEN, TEST_MASTER_KEY, fakeFiles, validEnv } from './testing';
import { secretValues } from './types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function failure(env: Record<string, string>, files: Record<string, string> = {}): ConfigError {
  try {
    loadInstanceConfig({ env, readFile: fakeFiles(files) });
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadInstanceConfig to throw');
}

function paths(err: ConfigError): string[] {
  return err.issues.map((i) => i.path);
}

describe('loadInstanceConfig — required keys', () => {
  it('loads the minimal environment-only configuration with defaults', () => {
    const { config, configFile } = loadInstanceConfig({ env: validEnv() });
    expect(configFile).toBeNull();
    expect(config.publicUrl.origin).toBe('https://gateway.example.com');
    expect(config.store.path).toBe('/tmp/vaubaan-test/gateway.db');
    expect(config.encryption.keyVersion).toBe(1);
    expect(config.encryption.masterKey).toHaveLength(32);
    expect(config.idp).toBeNull();
    expect(config.admin).toEqual({ group: null, emails: ['ops@example.com'] });
    expect(config.bootstrapToken).toBe(TEST_BOOTSTRAP_TOKEN);
    expect(config.telemetry).toEqual({
      enabled: false,
      collectorUrl: new URL(DEFAULT_TELEMETRY_COLLECTOR_URL),
    });
    expect(config.retentionDays).toBe(90);
    expect(config.requests.expirySeconds).toBe(24 * 3600);
    expect(config.approvals.expirySeconds).toBe(600);
    expect(config.log.level).toBe('info');
    expect(config.trustedProxies).toEqual([]);
    expect(config.providers.size).toBe(0);
  });

  it('names every missing required key at once, with its environment variable', () => {
    const err = failure({});
    expect(err.name).toBe('ConfigError');
    expect(paths(err)).toEqual(
      expect.arrayContaining([
        'public_url',
        'store.path',
        'encryption.master_key',
        'admin',
        'bootstrap_token',
      ]),
    );
    expect(err.message).toContain('Invalid instance configuration (5 problems)');
    expect(err.message).toContain(
      'encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)',
    );
    expect(err.message).toContain('public_url: missing required key (env: VAUBAAN_PUBLIC_URL)');
    expect(err.message).toContain('bootstrap_token: missing required key');
  });

  it('refuses an http public URL', () => {
    const err = failure(validEnv({ VAUBAAN_PUBLIC_URL: 'http://gateway.example.com' }));
    expect(paths(err)).toEqual(['public_url']);
    expect(formatIssue(err.issues[0]!)).toBe(
      'public_url: must use https (got http) (env: VAUBAAN_PUBLIC_URL)',
    );
  });

  it('refuses a public URL that is not a URL or carries a query string', () => {
    expect(paths(failure(validEnv({ VAUBAAN_PUBLIC_URL: 'gateway.example.com' })))).toEqual([
      'public_url',
    ]);
    expect(
      paths(failure(validEnv({ VAUBAAN_PUBLIC_URL: 'https://gateway.example.com/?x=1' }))),
    ).toEqual(['public_url']);
  });

  it('strips the trailing slash of the public URL but keeps a sub-path', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_PUBLIC_URL: 'https://intranet.example.com/gateway/' }),
    });
    expect(config.publicUrl.href).toBe('https://intranet.example.com/gateway');
  });

  it('refuses a master key that does not decode to 32 bytes', () => {
    const err = failure(validEnv({ VAUBAAN_MASTER_KEY: Buffer.alloc(16).toString('base64') }));
    expect(paths(err)).toEqual(['encryption.master_key']);
    expect(err.message).toContain('32 random bytes');
    expect(err.message).toContain('gen-master-key');
    expect(paths(failure(validEnv({ VAUBAAN_MASTER_KEY: 'not base64!!' })))).toEqual([
      'encryption.master_key',
    ]);
  });

  it('refuses a bootstrap token shorter than 32 characters', () => {
    expect(paths(failure(validEnv({ VAUBAAN_BOOTSTRAP_TOKEN: 'short' })))).toEqual([
      'bootstrap_token',
    ]);
  });

  it('validates trusted proxies as IPs or CIDR blocks', () => {
    const ok = loadInstanceConfig({
      env: validEnv({ VAUBAAN_TRUSTED_PROXIES: '10.0.0.1, 172.16.0.0/12, fd00::/8, ::1' }),
    });
    expect(ok.config.trustedProxies).toEqual(['10.0.0.1', '172.16.0.0/12', 'fd00::/8', '::1']);
    const err = failure(validEnv({ VAUBAAN_TRUSTED_PROXIES: 'proxy.example.com,10.0.0.0/33' }));
    expect(paths(err)).toEqual(['trusted_proxies', 'trusted_proxies']);
  });

  it('validates durations, integers, booleans and the log level', () => {
    const err = failure(
      validEnv({
        VAUBAAN_REQUEST_EXPIRY: 'tomorrow',
        VAUBAAN_RETENTION_DAYS: '0',
        VAUBAAN_TELEMETRY_ENABLED: 'maybe',
        VAUBAAN_LOG_LEVEL: 'loud',
        VAUBAAN_MASTER_KEY_VERSION: 'two',
      }),
    );
    expect(paths(err).sort()).toEqual(
      [
        'encryption.key_version',
        'log.level',
        'requests.expiry',
        'retention_days',
        'telemetry.enabled',
      ].sort(),
    );
    const ok = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_REQUEST_EXPIRY: '2d',
        VAUBAAN_APPROVAL_EXPIRY: '90s',
        VAUBAAN_RETENTION_DAYS: '30',
        VAUBAAN_TELEMETRY_ENABLED: 'true',
        VAUBAAN_TELEMETRY_COLLECTOR_URL: 'https://collector.example.net/ingest',
        VAUBAAN_LOG_LEVEL: 'debug',
      }),
    });
    expect(ok.config.requests.expirySeconds).toBe(172_800);
    expect(ok.config.approvals.expirySeconds).toBe(90);
    expect(ok.config.retentionDays).toBe(30);
    expect(ok.config.telemetry.enabled).toBe(true);
    expect(ok.config.telemetry.collectorUrl.href).toBe('https://collector.example.net/ingest');
    expect(ok.config.log.level).toBe('debug');
  });
});

describe('loadInstanceConfig — admin rule', () => {
  it('accepts a group name alone', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_ADMIN_EMAILS: undefined, VAUBAAN_ADMIN_GROUP: 'gateway-admins' }),
    });
    expect(config.admin).toEqual({ group: 'gateway-admins', emails: [] });
  });

  it('accepts an email list alone, lower-cased', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_ADMIN_EMAILS: 'Ops@Example.com, cto@example.com' }),
    });
    expect(config.admin.emails).toEqual(['ops@example.com', 'cto@example.com']);
  });

  it('accepts both, and refuses neither', () => {
    const both = loadInstanceConfig({
      env: validEnv({ VAUBAAN_ADMIN_GROUP: 'admins', VAUBAAN_ADMIN_EMAILS: 'a@example.com' }),
    });
    expect(both.config.admin).toEqual({ group: 'admins', emails: ['a@example.com'] });
    const err = failure(validEnv({ VAUBAAN_ADMIN_EMAILS: undefined }));
    expect(paths(err)).toEqual(['admin']);
    expect(err.message).toContain('VAUBAAN_ADMIN_GROUP or VAUBAAN_ADMIN_EMAILS');
  });

  it('refuses a value that is not an email address', () => {
    expect(paths(failure(validEnv({ VAUBAAN_ADMIN_EMAILS: 'ops' })))).toEqual(['admin.emails']);
  });
});

describe('loadInstanceConfig — IdP block', () => {
  const idpEnv = {
    VAUBAAN_IDP_ISSUER: 'https://login.example.com/realms/acme',
    VAUBAAN_IDP_CLIENT_ID: 'vaubaan-gateway',
    VAUBAAN_IDP_CLIENT_SECRET: 'idp-secret-value',
  };

  it('is optional as a whole; the bootstrap token is then required', () => {
    expect(loadInstanceConfig({ env: validEnv() }).config.idp).toBeNull();
    expect(paths(failure(validEnv({ VAUBAAN_BOOTSTRAP_TOKEN: undefined })))).toEqual([
      'bootstrap_token',
    ]);
  });

  it('makes the bootstrap token optional once configured, with default claim mapping', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ ...idpEnv, VAUBAAN_BOOTSTRAP_TOKEN: undefined }),
    });
    expect(config.bootstrapToken).toBeNull();
    expect(config.idp).toEqual({
      issuer: new URL('https://login.example.com/realms/acme'),
      clientId: 'vaubaan-gateway',
      clientSecret: 'idp-secret-value',
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
    });
  });

  it('names the missing sub-keys of a partial block and requires https', () => {
    const err = failure(validEnv({ VAUBAAN_IDP_ISSUER: 'http://login.example.com' }));
    expect(paths(err).sort()).toEqual(['idp.client_id', 'idp.client_secret', 'idp.issuer']);
  });

  it('reads claim mapping and allowed domains', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        ...idpEnv,
        VAUBAAN_IDP_CLAIM_GROUPS: 'memberOf',
        VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS: 'Example.com,example.org',
      }),
    });
    expect(config.idp?.claims.groups).toBe('memberOf');
    expect(config.idp?.allowedEmailDomains).toEqual(['example.com', 'example.org']);
  });
});

describe('loadInstanceConfig — provider apps', () => {
  it('parses VAUBAAN_PROVIDER_<ID>_<FIELD>, including hyphenated ids and _FILE secrets', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_PROVIDER_GITHUB_APP_ID: '12345',
        VAUBAAN_PROVIDER_GITHUB_APP_SLUG: 'acme-gateway',
        VAUBAAN_PROVIDER_GITHUB_PRIVATE_KEY_FILE: '/run/secrets/gh.pem',
        VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_ID: 'cf-id',
        VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_SECRET: 'cf-secret',
      }),
      readFile: fakeFiles({
        '/run/secrets/gh.pem': '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      }),
    });
    expect([...config.providers.keys()].sort()).toEqual(['cloudflare-dns', 'github']);
    expect(config.providers.get('github')).toEqual({
      appId: '12345',
      appSlug: 'acme-gateway',
      privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
    });
    expect(config.providers.get('cloudflare-dns')).toEqual({
      clientId: 'cf-id',
      clientSecret: 'cf-secret',
    });
  });

  it('refuses an unknown provider field in env and in YAML', () => {
    expect(paths(failure(validEnv({ VAUBAAN_PROVIDER_GITHUB_TOKEN: 'x' })))).toEqual(['providers']);
    const err = failure(validEnv({ [CONFIG_FILE_ENV]: '/config/gateway.yaml' }), {
      '/config/gateway.yaml': 'providers:\n  vercel:\n    token: abc\n',
    });
    expect(paths(err)).toEqual(['providers.vercel.token']);
  });
});

describe('loadInstanceConfig — YAML file and precedence', () => {
  const yaml = [
    'public_url: https://from-file.example.com',
    'store:',
    '  path: /data/gateway.db',
    'encryption:',
    '  master_key: ${MASTER}',
    '  key_version: 2',
    '  previous_keys:',
    '    1: ${file:/run/secrets/old_key}',
    'admin:',
    '  group: gateway-admins',
    'bootstrap_token: ${file:/run/secrets/bootstrap}',
    'trusted_proxies: [10.0.0.0/8]',
    'telemetry:',
    '  enabled: true',
    'requests:',
    '  expiry: 12h',
  ].join('\n');
  const oldKey = Buffer.alloc(32, 7).toString('base64');
  const files = {
    '/config/gateway.yaml': yaml,
    '/run/secrets/old_key': oldKey + '\n',
    '/run/secrets/bootstrap': TEST_BOOTSTRAP_TOKEN,
  };

  it('resolves ${VAR} and ${file:...} references and reads the typed tree', () => {
    const { config, configFile } = loadInstanceConfig({
      env: { [CONFIG_FILE_ENV]: '/config/gateway.yaml', MASTER: TEST_MASTER_KEY },
      readFile: fakeFiles(files),
    });
    expect(configFile).toBe('/config/gateway.yaml');
    expect(config.publicUrl.origin).toBe('https://from-file.example.com');
    expect(config.encryption.keyVersion).toBe(2);
    expect(Buffer.from(config.encryption.previousKeys.get(1)!).toString('base64')).toBe(oldKey);
    expect(config.admin).toEqual({ group: 'gateway-admins', emails: [] });
    expect(config.bootstrapToken).toBe(TEST_BOOTSTRAP_TOKEN);
    expect(config.trustedProxies).toEqual(['10.0.0.0/8']);
    expect(config.telemetry.enabled).toBe(true);
    expect(config.requests.expirySeconds).toBe(12 * 3600);
  });

  it('lets the file win over the environment, key by key', () => {
    const { config } = loadInstanceConfig({
      env: {
        ...validEnv({
          VAUBAAN_PUBLIC_URL: 'https://from-env.example.com',
          VAUBAAN_LOG_LEVEL: 'warn',
        }),
        [CONFIG_FILE_ENV]: '/config/gateway.yaml',
        MASTER: TEST_MASTER_KEY,
      },
      readFile: fakeFiles(files),
    });
    expect(config.publicUrl.origin).toBe('https://from-file.example.com'); // file wins
    expect(config.admin.group).toBe('gateway-admins'); // file wins
    expect(config.admin.emails).toEqual(['ops@example.com']); // env fills a key the file left out
    expect(config.log.level).toBe('warn'); // env-only key survives
  });

  it('names the key when a ${VAR} reference is unset or a secret file is missing', () => {
    const err = failure(
      { [CONFIG_FILE_ENV]: '/config/gateway.yaml' },
      {
        '/config/gateway.yaml': yaml,
        '/run/secrets/bootstrap': TEST_BOOTSTRAP_TOKEN,
      },
    );
    expect(paths(err)).toEqual(
      expect.arrayContaining(['encryption.master_key', 'encryption.previous_keys.1']),
    );
    expect(err.message).toContain('references ${MASTER} but that variable is not set');
    expect(err.message).toContain('cannot read secret file "/run/secrets/old_key"');
  });

  it('fails when the configured file is missing, invalid YAML or not a mapping', () => {
    expect(paths(failure(validEnv({ [CONFIG_FILE_ENV]: '/nope.yaml' })))).toEqual([
      CONFIG_FILE_ENV,
    ]);
    expect(
      paths(failure(validEnv({ [CONFIG_FILE_ENV]: '/bad.yaml' }), { '/bad.yaml': 'a: [1,\n' })),
    ).toEqual([CONFIG_FILE_ENV]);
    expect(
      paths(failure(validEnv({ [CONFIG_FILE_ENV]: '/list.yaml' }), { '/list.yaml': '- a\n- b\n' })),
    ).toEqual([CONFIG_FILE_ENV]);
  });

  it('treats an empty file as "no overrides"', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ [CONFIG_FILE_ENV]: '/empty.yaml' }),
      readFile: fakeFiles({ '/empty.yaml': '# nothing yet\n' }),
    });
    expect(config.publicUrl.origin).toBe('https://gateway.example.com');
  });

  it('refuses a previous key that duplicates the current version', () => {
    const err = failure(
      validEnv({ VAUBAAN_MASTER_KEY_VERSION: '3', VAUBAAN_MASTER_KEY_PREVIOUS: `3=${oldKey}` }),
    );
    expect(paths(err)).toEqual(['encryption.previous_keys.3']);
    expect(paths(failure(validEnv({ VAUBAAN_MASTER_KEY_PREVIOUS: 'garbage' })))).toEqual([
      'encryption.previous_keys',
    ]);
  });

  it('never echoes a malformed previous-keys entry (it may be a bare key)', () => {
    const err = failure(validEnv({ VAUBAAN_MASTER_KEY_PREVIOUS: oldKey }));
    expect(paths(err)).toEqual(['encryption.previous_keys']);
    expect(err.message).not.toContain(oldKey);
    expect(err.message).toContain('entry #1');
  });

  it('rejects a non-numeric previous key version and an empty key_version', () => {
    expect(paths(failure(validEnv({ VAUBAAN_MASTER_KEY_PREVIOUS: `one=${oldKey}` })))).toEqual([
      'encryption.previous_keys',
    ]);
    expect(paths(failure(validEnv({ VAUBAAN_MASTER_KEY_VERSION: '' })))).toEqual([
      'encryption.key_version',
    ]);
  });

  it('reports an unsupported ${...} syntax in the YAML instead of keeping it literally', () => {
    const err = failure(validEnv({ [CONFIG_FILE_ENV]: '/etc/gw.yaml' }), {
      '/etc/gw.yaml':
        'idp:\n  issuer: https://idp.example.com\n  client_id: a\n  client_secret: ${IDP_SECRET:-fallback}\n',
    });
    expect(paths(err)).toContain('idp.client_secret');
    expect(err.message).toContain('unsupported ${...} reference');
  });

  it('lists every secret of the configuration for the redactor', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_MASTER_KEY_VERSION: '2',
        VAUBAAN_MASTER_KEY_PREVIOUS: `1=${oldKey}`,
        VAUBAAN_IDP_ISSUER: 'https://idp.example.com',
        VAUBAAN_IDP_CLIENT_ID: 'gw',
        VAUBAAN_IDP_CLIENT_SECRET: 'idp-s3cret',
        VAUBAAN_PROVIDER_GITHUB_PRIVATE_KEY: 'pem-body',
        VAUBAAN_PROVIDER_VERCEL_CLIENT_SECRET: 'vercel-s3cret',
        VAUBAAN_PROVIDER_VERCEL_CLIENT_ID: 'public-id',
      }),
    });
    const secrets = secretValues(config);
    expect(secrets).toEqual(
      expect.arrayContaining([
        TEST_MASTER_KEY,
        oldKey,
        TEST_BOOTSTRAP_TOKEN,
        'idp-s3cret',
        'pem-body',
        'vercel-s3cret',
      ]),
    );
    expect(secrets).not.toContain('public-id');
  });

  it('refuses a secret given both directly and by _FILE', () => {
    const err = failure(validEnv({ VAUBAAN_MASTER_KEY_FILE: '/run/secrets/key' }), {
      '/run/secrets/key': TEST_MASTER_KEY,
    });
    expect(paths(err)).toEqual(['encryption.master_key']);
    expect(err.message).toContain('not both');
  });

  it('reads a secret from _FILE alone', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_MASTER_KEY: undefined, VAUBAAN_MASTER_KEY_FILE: '/run/secrets/key' }),
      readFile: fakeFiles({ '/run/secrets/key': TEST_MASTER_KEY + '\n' }),
    });
    expect(Buffer.from(config.encryption.masterKey).toString('base64')).toBe(TEST_MASTER_KEY);
  });
});

describe('provider environment names', () => {
  it('splits VAUBAAN_PROVIDER_<ID>_<FIELD> with hyphenated ids and the longest field', () => {
    expect(parseProviderEnvName('VAUBAAN_PROVIDER_GITHUB_APP_ID')).toEqual({
      providerId: 'github',
      field: 'app_id',
    });
    expect(parseProviderEnvName('VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_SECRET')).toEqual({
      providerId: 'cloudflare-dns',
      field: 'client_secret',
    });
    expect(parseProviderEnvName('VAUBAAN_PROVIDER_CLIENT_ID')).toBeNull();
    expect(parseProviderEnvName('VAUBAAN_PROVIDER_GITHUB_TOKEN')).toBeNull();
    expect(parseProviderEnvName('OTHER_GITHUB_APP_ID')).toBeNull();
  });
});

describe('KEYS and the example files stay in sync', () => {
  const configDir = resolve(__dirname, '../../../../../deploy/config');
  const envExample = readFileSync(resolve(configDir, '.env.example'), 'utf8');
  const yamlExample = readFileSync(resolve(configDir, 'gateway.example.yaml'), 'utf8');

  it('every environment variable appears in .env.example', () => {
    const missing = KEYS.map((k) => k.env).filter((env) => !envExample.includes(env));
    expect(missing).toEqual([]);
  });

  it('every YAML leaf appears in gateway.example.yaml', () => {
    const missing = KEYS.map((k) => k.path).filter((path) => {
      const leaf = path.split('.').pop() ?? path;
      return !new RegExp(`(^|\\n)\\s*#?\\s*${leaf}:`).test(yamlExample);
    });
    expect(missing).toEqual([]);
  });
});
