/**
 * The one absence the loader tolerates (ADR
 * master-key-generated-and-handed-over-by-the-instance): the master key *file*
 * the configuration names does not exist, and the configuration says what the
 * boot does about it. `loadInstanceConfigOrSetup` reports it as an outcome with
 * everything else validated; `loadInstanceConfig` keeps erroring, with a hint.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import { loadInstanceConfig, loadInstanceConfigOrSetup } from './load';
import { CONFIG_FILE_ENV } from './sources';
import { TEST_MASTER_KEY, fakeFiles, validEnv } from '../../../tests/support/config/testing';

const KEY_FILE = '/data/master.key';

function failure(env: Record<string, string | undefined>, files: Record<string, string> = {}) {
  try {
    loadInstanceConfig({ env: validEnv(env), readFile: fakeFiles(files) });
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('an absent master key file', () => {
  const absentWithGenerate = {
    VAUBAAN_MASTER_KEY: undefined,
    VAUBAAN_MASTER_KEY_FILE: KEY_FILE,
    VAUBAAN_MASTER_KEY_GENERATE: '1',
  };

  it('is an error without the opt-in, as before', () => {
    const err = failure({ VAUBAAN_MASTER_KEY: undefined, VAUBAAN_MASTER_KEY_FILE: KEY_FILE });
    expect(new Set(err.issues.map((i) => i.path))).toEqual(new Set(['encryption.master_key']));
    expect(err.message).toContain(`cannot read secret file "${KEY_FILE}"`);
    expect(err.message).toContain('(env: VAUBAAN_MASTER_KEY_FILE)');
    expect(err.message).not.toContain('first start');
    expect(() =>
      loadInstanceConfigOrSetup({
        env: validEnv({ VAUBAAN_MASTER_KEY: undefined, VAUBAAN_MASTER_KEY_FILE: KEY_FILE }),
        readFile: fakeFiles({}),
      }),
    ).toThrow(ConfigError);
  });

  it('with generate_master_key is a setup outcome carrying the path and everything else', () => {
    const outcome = loadInstanceConfigOrSetup({
      env: validEnv({ ...absentWithGenerate, VAUBAAN_LOG_LEVEL: 'warn' }),
      readFile: fakeFiles({}),
    });
    expect(outcome.kind).toBe('setup');
    if (outcome.kind !== 'setup') return;
    expect(outcome.reason).toBe('generate');
    expect(outcome.masterKeyFile).toBe(KEY_FILE);
    expect(outcome.config.store.path).toBe('/tmp/vaubaan-test/gateway.db');
    expect(outcome.config.log.level).toBe('warn');
    expect(outcome.config.publicUrl.origin).toBe('https://gateway.example.com');
    expect('encryption' in outcome.config).toBe(false);
    expect(outcome.issue.env).toEqual(['VAUBAAN_MASTER_KEY_FILE']);
    expect(outcome.secretEnvNames).toContain('VAUBAAN_MASTER_KEY_FILE');
  });

  it('with generate_master_key still fails the plain loader, with the hint to start the gateway', () => {
    const err = failure(absentWithGenerate);
    expect(err.issues.map((i) => i.path)).toEqual(['encryption.master_key']);
    expect(err.message).toContain('writes it at its first start');
  });

  it('with restore.from is a setup outcome too (the setup receives the key of the copy)', () => {
    const outcome = loadInstanceConfigOrSetup({
      env: validEnv({
        VAUBAAN_MASTER_KEY: undefined,
        VAUBAAN_MASTER_KEY_FILE: KEY_FILE,
        VAUBAAN_RESTORE_FROM: '/backups/copy.sqlite',
        VAUBAAN_RESTORE_SHA256: 'a'.repeat(64),
      }),
      readFile: fakeFiles({}),
    });
    expect(outcome.kind).toBe('setup');
    if (outcome.kind === 'setup') expect(outcome.reason).toBe('restore');
    const err = failure({
      VAUBAAN_MASTER_KEY: undefined,
      VAUBAAN_MASTER_KEY_FILE: KEY_FILE,
      VAUBAAN_RESTORE_FROM: '/backups/copy.sqlite',
      VAUBAAN_RESTORE_SHA256: 'a'.repeat(64),
    });
    expect(err.message).toContain('a restore needs the key the copy was sealed with');
  });

  it('is tolerated for the master key only: another absent secret file is still named', () => {
    expect(() =>
      loadInstanceConfigOrSetup({
        env: validEnv({
          ...absentWithGenerate,
          VAUBAAN_BOOTSTRAP_TOKEN: undefined,
          VAUBAAN_BOOTSTRAP_TOKEN_FILE: '/run/secrets/b',
        }),
        readFile: fakeFiles({}),
      }),
    ).toThrow(/bootstrap_token: cannot read secret file "\/run\/secrets\/b"/);
  });

  it('reports every other problem together with the absence, never a setup outcome', () => {
    expect(() =>
      loadInstanceConfigOrSetup({
        env: validEnv({ ...absentWithGenerate, VAUBAAN_PUBLIC_URL: 'http://plain.example.com' }),
        readFile: fakeFiles({}),
      }),
    ).toThrow(/public_url: must use https/);
  });

  it('is a setup outcome through a ${file:…} reference in the YAML file as well', () => {
    const outcome = loadInstanceConfigOrSetup({
      env: validEnv({ VAUBAAN_MASTER_KEY: undefined, [CONFIG_FILE_ENV]: '/config/gateway.yaml' }),
      readFile: fakeFiles({
        '/config/gateway.yaml': `encryption:\n  master_key: \${file:${KEY_FILE}}\n  generate_master_key: true\n`,
      }),
    });
    expect(outcome.kind).toBe('setup');
    if (outcome.kind === 'setup') expect(outcome.masterKeyFile).toBe(KEY_FILE);
  });
});

describe('generate_master_key with a key that exists', () => {
  it('is the steady state after the first start: the file is read, the flag is kept', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_MASTER_KEY: undefined,
        VAUBAAN_MASTER_KEY_FILE: KEY_FILE,
        VAUBAAN_MASTER_KEY_GENERATE: 'true',
      }),
      readFile: fakeFiles({ [KEY_FILE]: `${TEST_MASTER_KEY}\n` }),
    });
    expect(Buffer.from(config.encryption.masterKey).toString('base64')).toBe(TEST_MASTER_KEY);
    expect(config.encryption.masterKeyFile).toBe(KEY_FILE);
    expect(config.encryption.generateMasterKey).toBe(true);
  });

  it('names the file the key is read from, and null for a key given by value', () => {
    const byValue = loadInstanceConfig({ env: validEnv(), readFile: fakeFiles({}) });
    expect(byValue.config.encryption.masterKeyFile).toBeNull();
    expect(byValue.config.encryption.generateMasterKey).toBe(false);
    const yaml = loadInstanceConfig({
      env: validEnv({ VAUBAAN_MASTER_KEY: undefined, [CONFIG_FILE_ENV]: '/config/gateway.yaml' }),
      readFile: fakeFiles({
        '/config/gateway.yaml': `encryption:\n  master_key: \${file:/run/secrets/mk}\n`,
        '/run/secrets/mk': TEST_MASTER_KEY,
      }),
    });
    expect(yaml.config.encryption.masterKeyFile).toBe('/run/secrets/mk');
  });

  it('refuses the flag on a key given by value: there is nothing to write', () => {
    const err = failure({ VAUBAAN_MASTER_KEY_GENERATE: '1' });
    expect(err.issues.map((i) => i.path)).toEqual(['encryption.generate_master_key']);
    expect(err.message).toContain('applies to a key read from a file');
    expect(err.message).toContain('VAUBAAN_MASTER_KEY_FILE');
  });

  it('refuses the flag with restore.from: a copy opens with the key it was sealed with', () => {
    const err = failure(
      {
        VAUBAAN_MASTER_KEY: undefined,
        VAUBAAN_MASTER_KEY_FILE: KEY_FILE,
        VAUBAAN_MASTER_KEY_GENERATE: '1',
        VAUBAAN_RESTORE_FROM: '/backups/copy.sqlite',
        VAUBAAN_RESTORE_SHA256: 'a'.repeat(64),
      },
      { [KEY_FILE]: TEST_MASTER_KEY },
    );
    expect(err.issues.map((i) => i.path)).toEqual(['encryption.generate_master_key']);
    expect(err.message).toContain('cannot be set with restore.from');
  });
});
