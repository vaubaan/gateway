/**
 * Local mode (ADR local-mode-for-an-instance-on-this-computer): what `local` supplies,
 * what it still lets a person set, and the public URL it alone accepts.
 */
import { describe, expect, it } from 'vitest';

import { TEST_MASTER_KEY, fakeFiles } from '../../../tests/support/config/testing';
import { ConfigError } from './errors';
import { loadInstanceConfig, loadInstanceConfigOrSetup } from './load';
import { CONFIG_FILE_ENV } from './sources';

const KEY_FILE = '/data/master.key';

function issuesOf(env: Record<string, string>, files: Record<string, string> = {}): ConfigError {
  try {
    loadInstanceConfig({ env, readFile: fakeFiles(files) });
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadInstanceConfig to throw');
}

describe('local mode', () => {
  it('needs nothing but the switch: the key file to generate is the only thing missing', () => {
    const outcome = loadInstanceConfigOrSetup({
      env: { VAUBAAN_LOCAL: 'true', NODE_ENV: 'production' },
      readFile: fakeFiles({}),
    });
    expect(outcome.kind).toBe('setup');
    if (outcome.kind !== 'setup') return;
    expect(outcome.reason).toBe('generate');
    expect(outcome.masterKeyFile).toBe(KEY_FILE);
    expect(outcome.config.local).toBe(true);
    expect(outcome.config.publicUrl.href).toBe('http://localhost:3000/');
    expect(outcome.config.store.path).toBe('/data/gateway.db');
    expect(outcome.config.bootstrapToken).toBeNull();
  });

  it('loads with the key file there, the key beside the store accepted', () => {
    const { config } = loadInstanceConfig({
      env: { VAUBAAN_LOCAL: '1', NODE_ENV: 'production' },
      readFile: fakeFiles({ [KEY_FILE]: TEST_MASTER_KEY }),
    });
    expect(config.local).toBe(true);
    expect(config.encryption.masterKeyFile).toBe(KEY_FILE);
    expect(config.encryption.generateMasterKey).toBe(true);
    expect(config.encryption.acceptKeyBesideStore).toBe(true);
  });

  it('keeps every key a person sets, by value or by file', () => {
    const { config } = loadInstanceConfig({
      env: {
        VAUBAAN_LOCAL: 'true',
        VAUBAAN_PUBLIC_URL: 'http://127.0.0.1:8080',
        VAUBAAN_STORE_PATH: '/elsewhere/gateway.db',
        VAUBAAN_MASTER_KEY: TEST_MASTER_KEY,
      },
      readFile: fakeFiles({}),
    });
    expect(config.publicUrl.origin).toBe('http://127.0.0.1:8080');
    expect(config.store.path).toBe('/elsewhere/gateway.db');
    expect(config.encryption.masterKeyFile).toBeNull();
  });

  it('is asked by the file as well, which wins over the environment', () => {
    const files = { '/config/gateway.yaml': 'local: true\n', [KEY_FILE]: TEST_MASTER_KEY };
    const { config } = loadInstanceConfig({
      env: { [CONFIG_FILE_ENV]: '/config/gateway.yaml', VAUBAAN_LOCAL: 'false' },
      readFile: fakeFiles(files),
    });
    expect(config.local).toBe(true);
    expect(config.publicUrl.origin).toBe('http://localhost:3000');
  });

  it('refuses a host other than loopback, over http or https', () => {
    for (const url of ['http://192.168.1.10:3000', 'https://gateway.example.com']) {
      const err = issuesOf(
        { VAUBAAN_LOCAL: 'true', VAUBAAN_PUBLIC_URL: url },
        { [KEY_FILE]: TEST_MASTER_KEY },
      );
      expect(err.issues.map((i) => i.path)).toEqual(['public_url']);
      expect(err.issues[0]?.message).toContain('this computer only');
    }
  });

  it('accepts [::1] and an https loopback URL', () => {
    for (const url of ['http://[::1]:3000', 'https://localhost:3443']) {
      const { config } = loadInstanceConfig({
        env: { VAUBAAN_LOCAL: 'true', VAUBAAN_PUBLIC_URL: url },
        readFile: fakeFiles({ [KEY_FILE]: TEST_MASTER_KEY }),
      });
      expect(config.publicUrl.origin).toBe(url);
    }
  });
});

describe('without local mode', () => {
  it('an http public URL stays an error, even on localhost', () => {
    const err = issuesOf({
      VAUBAAN_PUBLIC_URL: 'http://localhost:3000',
      VAUBAAN_STORE_PATH: '/data/gateway.db',
      VAUBAAN_MASTER_KEY: TEST_MASTER_KEY,
      VAUBAAN_BOOTSTRAP_TOKEN: 'b'.repeat(32),
    });
    expect(err.issues.map((i) => i.path)).toEqual(['public_url']);
    expect(err.issues[0]?.message).toContain('must use https');
  });

  it('supplies nothing: the keys a local instance gets are still required', () => {
    const err = issuesOf({});
    expect(err.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        'public_url',
        'store.path',
        'encryption.master_key',
        'bootstrap_token',
      ]),
    );
  });
});
