/**
 * `limits.*` and `ops.token` (spec §4.3 bis): optional, a ceiling absent is unlimited,
 * a ceiling is a whole number >= 1, the counters token is a secret of at least 32
 * characters read like every other (a `_FILE` sibling, `${file:…}`), and redacted.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createRedactor } from '../logging/redact';
import { ConfigError } from './errors';
import { loadInstanceConfig } from './load';
import { CONFIG_FILE_ENV } from './sources';
import { fakeFiles, validEnv } from '../../../tests/support/config/testing';
import { secretValues } from './types';

const OPS_TOKEN = 'ops-' + randomBytes(24).toString('hex');

function issuesOf(env: Record<string, string>, files: Record<string, string> = {}): string[] {
  try {
    loadInstanceConfig({ env, readFile: fakeFiles(files) });
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((issue) => issue.path);
    throw err;
  }
  throw new Error('expected the configuration to be refused');
}

describe('limits.* — the ceilings', () => {
  it('are unlimited when absent: the default', () => {
    const { config } = loadInstanceConfig({ env: validEnv() });
    expect(config.limits).toEqual({ users: null, accounts: null, activeMissions: null });
  });

  it('read the environment', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_LIMITS_USERS: '10',
        VAUBAAN_LIMITS_ACCOUNTS: '25',
        VAUBAAN_LIMITS_ACTIVE_MISSIONS: '3',
      }),
    });
    expect(config.limits).toEqual({ users: 10, accounts: 25, activeMissions: 3 });
  });

  it('read the file, each one alone', () => {
    const path = '/config/gateway.yaml';
    const { config } = loadInstanceConfig({
      env: validEnv({ [CONFIG_FILE_ENV]: path }),
      readFile: fakeFiles({ [path]: 'limits:\n  active_missions: 1\n' }),
    });
    expect(config.limits).toEqual({ users: null, accounts: null, activeMissions: 1 });
  });

  it('refuse the retired name of the accounts ceiling, file or variable, naming limits.accounts (ADR one-word-per-thing-account-service-plugin)', () => {
    expect(issuesOf(validEnv({ VAUBAAN_LIMITS_CONNECTIONS: '7' }))).toEqual(['limits.connections']);
    expect(
      issuesOf(validEnv({ VAUBAAN_LIMITS_CONNECTIONS: '7', VAUBAAN_LIMITS_ACCOUNTS: '9' })),
    ).toEqual(['limits.connections']);
    const path = '/config/gateway.yaml';
    expect(
      issuesOf(validEnv({ [CONFIG_FILE_ENV]: path }), { [path]: 'limits:\n  connections: 4\n' }),
    ).toEqual(['limits.connections']);
    try {
      loadInstanceConfig({ env: validEnv({ VAUBAAN_LIMITS_CONNECTIONS: '7' }) });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues[0]?.message).toContain('limits.accounts');
    }
  });

  it.each([
    ['0', 'VAUBAAN_LIMITS_USERS', 'limits.users'],
    ['-2', 'VAUBAAN_LIMITS_ACCOUNTS', 'limits.accounts'],
    ['1.5', 'VAUBAAN_LIMITS_ACTIVE_MISSIONS', 'limits.active_missions'],
    ['ten', 'VAUBAAN_LIMITS_USERS', 'limits.users'],
  ])('refuse %s (%s)', (value, variable, path) => {
    expect(issuesOf(validEnv({ [variable]: value }))).toEqual([path]);
  });
});

describe('ops.token — the counters endpoint', () => {
  it('is absent by default: the endpoint does not exist', () => {
    expect(loadInstanceConfig({ env: validEnv() }).config.ops).toEqual({ token: null });
  });

  it('is read from the environment or from a file named by its `_FILE` sibling', () => {
    expect(
      loadInstanceConfig({ env: validEnv({ VAUBAAN_OPS_TOKEN: OPS_TOKEN }) }).config.ops.token,
    ).toBe(OPS_TOKEN);
    const loaded = loadInstanceConfig({
      env: validEnv({ VAUBAAN_OPS_TOKEN_FILE: '/run/secrets/ops_token' }),
      readFile: fakeFiles({ '/run/secrets/ops_token': `${OPS_TOKEN}\n` }),
    });
    expect(loaded.config.ops.token).toBe(OPS_TOKEN);
    // A variable that carried a secret is scrubbed from the process once loaded.
    expect(loaded.secretEnvNames).toContain('VAUBAAN_OPS_TOKEN_FILE');
  });

  it('refuses a token shorter than 32 characters', () => {
    expect(issuesOf(validEnv({ VAUBAAN_OPS_TOKEN: 'x'.repeat(31) }))).toEqual(['ops.token']);
  });

  it('is a secret: the log redactor masks it', () => {
    const { config } = loadInstanceConfig({ env: validEnv({ VAUBAAN_OPS_TOKEN: OPS_TOKEN }) });
    expect(secretValues(config)).toContain(OPS_TOKEN);
    const redact = createRedactor(secretValues(config));
    expect(redact(`authorization: Bearer ${OPS_TOKEN}`)).not.toContain(OPS_TOKEN);
  });
});
