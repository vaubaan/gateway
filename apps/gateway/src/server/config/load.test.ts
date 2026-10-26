import { describe, expect, it } from 'vitest';

import { ConfigError, formatIssue } from './errors';
import { createRedactor } from '../logging/redact';
import { loadInstanceConfig, MASTER_KEY_BYTES } from './load';
import { CONFIG_FILE_ENV } from './sources';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from './telemetry-default';
import { KEYS, secretEnvVariables } from './sources';
import { TEST_BOOTSTRAP_TOKEN, TEST_MASTER_KEY, fakeFiles, validEnv } from './testing';
import { secretValues } from './types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
      enabledSetByConfig: false,
      level: 'usage-stats',
      collectorUrl: new URL(DEFAULT_TELEMETRY_COLLECTOR_URL),
    });
    expect(config.retentionDays).toBe(90);
    expect(config.requests.expirySeconds).toBe(24 * 3600);
    expect(config.approvals.expirySeconds).toBe(600);
    expect(config.log.level).toBe('info');
    expect(config.trustedProxies).toEqual([]);
    expect(config.retiredKeys).toEqual([]);
  });

  it('names every missing required key at once, with its environment variable', () => {
    const err = failure({});
    expect(err.name).toBe('ConfigError');
    expect(paths(err)).toEqual(
      expect.arrayContaining([
        'public_url',
        'store.path',
        'encryption.master_key',
        'bootstrap_token',
      ]),
    );
    expect(paths(err)).not.toContain('admin');
    expect(err.message).toContain('Invalid instance configuration (4 problems)');
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
    expect(ok.config.telemetry.enabledSetByConfig).toBe(true);
    expect(ok.config.telemetry.collectorUrl.href).toBe('https://collector.example.net/ingest');
    expect(ok.config.log.level).toBe('debug');
  });

  it('tells an explicit telemetry.enabled, true or false, from one that is not set', () => {
    const set = (value: string | undefined) =>
      loadInstanceConfig({ env: validEnv({ VAUBAAN_TELEMETRY_ENABLED: value }) }).config.telemetry;
    expect(set(undefined)).toMatchObject({ enabled: false, enabledSetByConfig: false });
    expect(set('false')).toMatchObject({ enabled: false, enabledSetByConfig: true });
    expect(set('true')).toMatchObject({ enabled: true, enabledSetByConfig: true });

    // A YAML key left empty is not a decision.
    const path = '/config/gateway.yaml';
    const fromFile = loadInstanceConfig({
      env: validEnv({ [CONFIG_FILE_ENV]: path }),
      readFile: fakeFiles({ [path]: 'telemetry:\n  enabled:\n' }),
    }).config.telemetry;
    expect(fromFile).toMatchObject({ enabled: false, enabledSetByConfig: false });
  });
});

describe('loadInstanceConfig — instance name', () => {
  const FILE = '/config/gateway.yaml';
  const name = (env: Record<string, string | undefined>, file?: string) =>
    loadInstanceConfig({
      env: validEnv(file === undefined ? env : { ...env, [CONFIG_FILE_ENV]: FILE }),
      readFile: fakeFiles(file === undefined ? {} : { [FILE]: file }),
    }).config.instanceName;

  it('is not set by default, nor by a blank value: Administration decides then', () => {
    expect(name({})).toBeNull();
    expect(name({ VAUBAAN_INSTANCE_NAME: '   ' })).toBeNull();
    expect(name({}, 'instance_name:\n')).toBeNull();
  });

  it('is read from the environment and trimmed', () => {
    expect(name({ VAUBAAN_INSTANCE_NAME: '  Dalae · prod  ' })).toBe('Dalae · prod');
  });

  it('is read from the mounted file, which wins over the environment', () => {
    expect(name({ VAUBAAN_INSTANCE_NAME: 'from env' }, 'instance_name: Fiabilis AI\n')).toBe(
      'Fiabilis AI',
    );
  });

  it('refuses a name too long or with a control character, naming the key and its variable', () => {
    const long = failure(validEnv({ VAUBAAN_INSTANCE_NAME: 'x'.repeat(65) }));
    expect(paths(long)).toEqual(['instance_name']);
    expect(long.message).toContain('VAUBAAN_INSTANCE_NAME');
    expect(long.message).toContain('64 characters or fewer');
    expect(name({ VAUBAAN_INSTANCE_NAME: 'x'.repeat(64) })).toHaveLength(64);

    const control = failure(validEnv({ VAUBAAN_INSTANCE_NAME: 'prod\u0007' }));
    expect(paths(control)).toEqual(['instance_name']);
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

  it('accepts both, and neither: the rule is an optional seed (ADR administrators-live-in-the-instance)', () => {
    const both = loadInstanceConfig({
      env: validEnv({ VAUBAAN_ADMIN_GROUP: 'admins', VAUBAAN_ADMIN_EMAILS: 'a@example.com' }),
    });
    expect(both.config.admin).toEqual({ group: 'admins', emails: ['a@example.com'] });
    const none = loadInstanceConfig({ env: validEnv({ VAUBAAN_ADMIN_EMAILS: undefined }) });
    expect(none.config.admin).toEqual({ group: null, emails: [] });
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
      invitationOnly: false,
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

describe('loadInstanceConfig — the retired OAuth clients of providers', () => {
  // ADR gmail-over-imap-with-an-app-password: no OAuth client is declared by an administrator.
  it('starts, reads none of them, and lists every key and variable still set', () => {
    const { config, secretEnvNames } = loadInstanceConfig({
      env: validEnv({
        [CONFIG_FILE_ENV]: '/config/gateway.yaml',
        VAUBAAN_PROVIDER_GMAIL_CLIENT_ID: '12345.apps.googleusercontent.com',
        VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET_FILE: '/run/secrets/gmail',
        VAUBAAN_PROVIDER_GITHUB_TOKEN: 'x',
      }),
      readFile: fakeFiles({
        '/config/gateway.yaml':
          'providers:\n  gmail:\n    client_id: abc\n    client_secret: s3cret\n  vercel: {}\n',
      }),
    });
    expect(config.retiredKeys).toEqual([
      'VAUBAAN_PROVIDER_GITHUB_TOKEN',
      'VAUBAAN_PROVIDER_GMAIL_CLIENT_ID',
      'VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET_FILE',
      'providers.gmail.client_id',
      'providers.gmail.client_secret',
      'providers.vercel',
    ]);
    // Taken out of the process environment with the secrets: one of them held a client secret.
    expect(secretEnvNames).toEqual(
      expect.arrayContaining([
        'VAUBAAN_PROVIDER_GITHUB_TOKEN',
        'VAUBAAN_PROVIDER_GMAIL_CLIENT_ID',
        'VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET_FILE',
      ]),
    );
    expect(secretEnvVariables({ VAUBAAN_PROVIDER_X_CLIENT_ID: 'a' })).toEqual([
      'VAUBAAN_PROVIDER_X_CLIENT_ID',
    ]);
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
      }),
    });
    const secrets = secretValues(config);
    expect(secrets).toEqual(
      expect.arrayContaining([TEST_MASTER_KEY, oldKey, TEST_BOOTSTRAP_TOKEN, 'idp-s3cret']),
    );
    expect(secrets).not.toContain('gw');
  });

  it('registers a master key with the redactor in the form it was configured in (base64url, unpadded)', () => {
    // 32 bytes of 0xfb encode with `+` and `/` in base64, `-` and `_` in base64url.
    const bytes = Buffer.alloc(MASTER_KEY_BYTES, 0xfb);
    const forms = [
      bytes.toString('base64'),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
    ];
    expect(new Set(forms).size).toBe(3);
    for (const configured of forms) {
      const { config } = loadInstanceConfig({
        env: validEnv({
          VAUBAAN_MASTER_KEY: configured,
          VAUBAAN_MASTER_KEY_VERSION: '2',
          VAUBAAN_MASTER_KEY_PREVIOUS: `1=${configured}`,
        }),
      });
      const redact = createRedactor(secretValues(config));
      expect(redact(`key=${configured} end`), configured).not.toContain(configured);
    }
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

  // The example is copied as is by the quick start: a value left active in it
  // would silently win over `.env` (the file has precedence).
  it('the example YAML is fully commented out: it parses to an empty document', () => {
    expect(parseYaml(yamlExample) ?? null).toBeNull();
  });

  it('the example YAML copied as is overrides nothing: the values come from the environment', () => {
    const path = '/config/gateway.yaml';
    const { config, configFile } = loadInstanceConfig({
      env: validEnv({ [CONFIG_FILE_ENV]: path }),
      readFile: fakeFiles({ [path]: yamlExample }),
    });
    expect(configFile).toBe(path);
    expect(config.publicUrl.origin).toBe('https://gateway.example.com');
    expect(config.admin).toEqual({ group: null, emails: ['ops@example.com'] });
    expect(config.idp).toBeNull();
    expect(config.retiredKeys).toEqual([]);
    expect(config.bootstrapToken).toBe(TEST_BOOTSTRAP_TOKEN);
  });
});

describe('loadInstanceConfig — authorization server of the management door', () => {
  it('defaults to short tokens and operator-approved registration with the loopback exception', () => {
    const { config } = loadInstanceConfig({ env: validEnv() });
    expect(config.oauth).toEqual({
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 30 * 86_400,
      delegationMaxLifetimeSeconds: 90 * 86_400,
      refreshReuseWindowSeconds: 30,
      clientRegistration: {
        policy: 'operator-approved',
        autoApproveLoopback: true,
        metadataDocuments: false,
      },
    });
  });

  it('reads every key from the environment', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_OAUTH_ACCESS_TOKEN_TTL: '5m',
        VAUBAAN_OAUTH_REFRESH_TOKEN_TTL: '7d',
        VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME: '30d',
        VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS: '0',
        VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY: 'closed',
        VAUBAAN_OAUTH_CLIENT_REGISTRATION_AUTO_APPROVE_LOOPBACK: 'false',
        VAUBAAN_OAUTH_CLIENT_REGISTRATION_METADATA_DOCUMENTS: 'true',
      }),
    });
    expect(config.oauth).toEqual({
      accessTokenTtlSeconds: 300,
      refreshTokenTtlSeconds: 7 * 86_400,
      delegationMaxLifetimeSeconds: 30 * 86_400,
      refreshReuseWindowSeconds: 0,
      clientRegistration: { policy: 'closed', autoApproveLoopback: false, metadataDocuments: true },
    });
  });

  it('reads the same keys from the YAML file, which wins', () => {
    const path = '/config/gateway.yaml';
    const { config } = loadInstanceConfig({
      env: validEnv({
        [CONFIG_FILE_ENV]: path,
        VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY: 'closed',
      }),
      readFile: fakeFiles({
        [path]: [
          'oauth:',
          '  access_token_ttl: 10m',
          '  client_registration:',
          '    policy: open',
          '    auto_approve_loopback: false',
        ].join('\n'),
      }),
    });
    expect(config.oauth.accessTokenTtlSeconds).toBe(600);
    expect(config.oauth.clientRegistration).toEqual({
      policy: 'open',
      autoApproveLoopback: false,
      metadataDocuments: false,
    });
  });

  it('refuses an access token that is not short-lived', () => {
    const err = failure(validEnv({ VAUBAAN_OAUTH_ACCESS_TOKEN_TTL: '2h' }));
    expect(paths(err)).toEqual(['oauth.access_token_ttl']);
    expect(err.message).toContain('at most 1h');
    expect(err.message).toContain('VAUBAAN_OAUTH_ACCESS_TOKEN_TTL');
  });

  it('refuses a refresh token that does not outlive the access token', () => {
    const err = failure(
      validEnv({ VAUBAAN_OAUTH_ACCESS_TOKEN_TTL: '30m', VAUBAAN_OAUTH_REFRESH_TOKEN_TTL: '30m' }),
    );
    expect(paths(err)).toEqual(['oauth.refresh_token_ttl']);
  });

  it('caps the reuse window of a rotated refresh token at one minute', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS: '60' }),
    });
    expect(config.oauth.refreshReuseWindowSeconds).toBe(60);
    const err = failure(validEnv({ VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS: '61' }));
    expect(paths(err)).toEqual(['oauth.refresh_reuse_window_seconds']);
    expect(err.message).toContain('at most 60');
    expect(err.message).toContain('VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS');
    expect(paths(failure(validEnv({ VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS: '-1' })))).toEqual([
      'oauth.refresh_reuse_window_seconds',
    ]);
  });

  it('refuses an unknown policy and a malformed duration, naming each key', () => {
    const err = failure(
      validEnv({
        VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY: 'everyone',
        VAUBAAN_OAUTH_REFRESH_TOKEN_TTL: 'a month',
      }),
    );
    expect(paths(err).sort()).toEqual([
      'oauth.client_registration.policy',
      'oauth.refresh_token_ttl',
    ]);
    expect(err.message).toContain('open, operator-approved, closed');
  });
});

describe('loadInstanceConfig — boolean and integer spellings per source', () => {
  const path = '/config/gateway.yaml';
  function fromYaml(yaml: string): ReturnType<typeof loadInstanceConfig> {
    return loadInstanceConfig({
      env: validEnv({ [CONFIG_FILE_ENV]: path }),
      readFile: fakeFiles({ [path]: yaml }),
    });
  }

  it.each(['yes', 'ON', '1', 'True'])('a variable set to %s is true', (raw) => {
    const { config } = loadInstanceConfig({ env: validEnv({ VAUBAAN_TELEMETRY_ENABLED: raw }) });
    expect(config.telemetry).toMatchObject({ enabled: true, enabledSetByConfig: true });
  });

  it('the file takes a YAML boolean and a YAML number', () => {
    const { config } = fromYaml('telemetry:\n  enabled: true\nretention_days: 30\n');
    expect(config.telemetry.enabled).toBe(true);
    expect(config.retentionDays).toBe(30);
  });

  it.each(['yes', '"true"', 'on'])('the file refuses the boolean spelling %s', (raw) => {
    const err = failure(
      { ...validEnv({ [CONFIG_FILE_ENV]: path }) },
      {
        [path]: `telemetry:\n  enabled: ${raw}\n`,
      },
    );
    expect(paths(err)).toEqual(['telemetry.enabled']);
    expect(formatIssue(err.issues[0]!)).toContain('expected true or false');
  });

  it('the file refuses a quoted integer', () => {
    const err = failure(
      { ...validEnv({ [CONFIG_FILE_ENV]: path }) },
      {
        [path]: 'retention_days: "30"\n',
      },
    );
    expect(paths(err)).toEqual(['retention_days']);
  });
});

describe('loadInstanceConfig — self resources (SEC 2026-10-15 H1)', () => {
  it('has none off Railway and without the key', () => {
    expect(loadInstanceConfig({ env: validEnv() }).config.selfResources).toEqual([]);
  });

  it("counts the Railway project the instance runs in, from the platform's variable", () => {
    const { config } = loadInstanceConfig({
      env: validEnv({ RAILWAY_PROJECT_ID: 'b6f0c3a2-1d2e-4f5a-8b9c-0d1e2f3a4b5c' }),
    });
    expect(config.selfResources).toEqual([
      { provider: 'railway', ref: 'b6f0c3a2-1d2e-4f5a-8b9c-0d1e2f3a4b5c', source: 'railway' },
    ]);
  });

  it('adds the configured <provider>:<ref> entries, without duplicating the platform one', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        RAILWAY_PROJECT_ID: 'proj-1',
        VAUBAAN_SELF_RESOURCES: 'railway:proj-1, vercel:prj_gateway,supabase:abcdefghijklmnopqrst',
      }),
    });
    expect(config.selfResources).toEqual([
      { provider: 'railway', ref: 'proj-1', source: 'railway' },
      { provider: 'vercel', ref: 'prj_gateway', source: 'config' },
      { provider: 'supabase', ref: 'abcdefghijklmnopqrst', source: 'config' },
    ]);
  });

  it('refuses an entry that is not <provider>:<ref>, naming the key and its variable', () => {
    const err = failure(validEnv({ VAUBAAN_SELF_RESOURCES: 'proj-1,railway:' }));
    expect(paths(err)).toEqual(['self_resources', 'self_resources']);
    expect(err.issues[0]?.env).toContain('VAUBAAN_SELF_RESOURCES');
  });
});
