/**
 * The boot's configuration loader over fakes: what it generates, when it
 * refuses, and that the operator commands' loader is untouched.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadInstanceConfig } from '../config';
import { TEST_MASTER_KEY, fakeFiles, validEnv } from '../config/testing';
import { generateMasterKeyText } from '../crypto/master-key-file';
import { loadBootConfig, loadBootConfigOrSetup, type BootConfigDeps } from './boot-config';

const KEY_FILE = '/data/master.key';
const STORE = '/data/gateway.db';

function harness(
  files: Record<string, string>,
  overrides: Partial<BootConfigDeps> & { env?: Record<string, string | undefined> } = {},
) {
  const written: Record<string, string> = {};
  const env = validEnv({
    VAUBAAN_STORE_PATH: STORE,
    VAUBAAN_MASTER_KEY: undefined,
    VAUBAAN_MASTER_KEY_FILE: KEY_FILE,
    VAUBAAN_MASTER_KEY_GENERATE: '1',
    ...overrides.env,
  });
  const { env: _env, ...rest } = overrides;
  const deps: BootConfigDeps = {
    env,
    readFile: (path) => fakeFiles({ ...files, ...written })(path),
    storeHasContent: () => false,
    writeKeyFile: (path, text) => {
      if (path in files || path in written) {
        throw new Error(`EEXIST: file already exists, open '${path}'`);
      }
      written[path] = text;
    },
    scrub: false,
    ...rest,
  };
  return { deps, env, written };
}

describe('loadBootConfig', () => {
  it('generates the key file when it is absent and the opt-in is on, then loads with it', () => {
    const { deps, written } = harness({});
    const loaded = loadBootConfig(deps);
    expect(Object.keys(written)).toEqual([KEY_FILE]);
    expect(written[KEY_FILE]).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(loaded.masterKeyGenerated).toBe(true);
    expect(Buffer.from(loaded.config.encryption.masterKey).toString('base64')).toBe(
      written[KEY_FILE]?.trim(),
    );
    expect(loaded.config.encryption.masterKeyFile).toBe(KEY_FILE);
  });

  it('reads an existing key file and generates nothing: the steady state', () => {
    const { deps, written } = harness({ [KEY_FILE]: `${TEST_MASTER_KEY}\n` });
    const loaded = loadBootConfig(deps);
    expect(written).toEqual({});
    expect(loaded.masterKeyGenerated).toBe(false);
    expect(Buffer.from(loaded.config.encryption.masterKey).toString('base64')).toBe(
      TEST_MASTER_KEY,
    );
  });

  it('refuses to generate when the store already holds data, naming both paths', () => {
    const { deps, written } = harness({}, { storeHasContent: (path) => path === STORE });
    expect(() => loadBootConfig(deps)).toThrow(ConfigError);
    try {
      loadBootConfig(deps);
    } catch (err) {
      const message = String((err as Error).message);
      expect(message).toContain('encryption.master_key');
      expect(message).toContain(`the key file "${KEY_FILE}" does not exist`);
      expect(message).toContain(`the store at '${STORE}' already holds data`);
      expect(message).toContain('never a reason to generate a new one');
      expect(message).toContain('(env: VAUBAAN_MASTER_KEY_FILE)');
    }
    expect(written).toEqual({});
  });

  it('without the opt-in a missing key file is the error it always was', () => {
    const { deps, written } = harness({}, { env: { VAUBAAN_MASTER_KEY_GENERATE: undefined } });
    expect(() => loadBootConfig(deps)).toThrow(/cannot read secret file "\/data\/master.key"/);
    expect(written).toEqual({});
  });

  it('with restore.from and no key, the boot has nothing to verify the copy with', () => {
    const { deps, written } = harness(
      {},
      {
        env: {
          VAUBAAN_MASTER_KEY_GENERATE: undefined,
          VAUBAAN_RESTORE_FROM: '/backups/copy.sqlite',
          VAUBAAN_RESTORE_SHA256: 'b'.repeat(64),
        },
      },
    );
    expect(() => loadBootConfig(deps)).toThrow(/a restore needs the key the copy was sealed with/);
    expect(written).toEqual({});
  });

  it('with restore.from, no key and an empty store, the boot starts in setup mode with a scrubbed environment', () => {
    const { deps, env, written } = harness(
      {},
      {
        scrub: true,
        env: {
          VAUBAAN_MASTER_KEY_GENERATE: undefined,
          VAUBAAN_RESTORE_FROM: '/backups/copy.sqlite',
          VAUBAAN_RESTORE_SHA256: 'b'.repeat(64),
        },
      },
    );
    const outcome = loadBootConfigOrSetup(deps);
    expect(outcome.kind).toBe('setup');
    if (outcome.kind !== 'setup') return;
    expect(outcome.setup.reason).toBe('restore');
    expect(outcome.setup.masterKeyFile).toBe(KEY_FILE);
    expect(written).toEqual({});
    expect(env.VAUBAAN_RESTORE_FROM).toBeUndefined();
    expect(env.VAUBAAN_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(env.VAUBAAN_MASTER_KEY_FILE).toBeUndefined();
    // The snapshot the final load reads still carries them.
    expect(outcome.env.VAUBAAN_RESTORE_FROM).toBe('/backups/copy.sqlite');
    expect(outcome.env.VAUBAAN_MASTER_KEY_FILE).toBe(KEY_FILE);
  });

  it('with restore.from, no key and a store that holds data, it is a configuration error', () => {
    const { deps } = harness(
      {},
      {
        storeHasContent: (path) => path === STORE,
        env: {
          VAUBAAN_MASTER_KEY_GENERATE: undefined,
          VAUBAAN_RESTORE_FROM: '/backups/copy.sqlite',
          VAUBAAN_RESTORE_SHA256: 'b'.repeat(64),
        },
      },
    );
    expect(() => loadBootConfigOrSetup(deps)).toThrow(/the store already holds data/);
  });

  it('turns a write failure into a configuration error naming the file', () => {
    const { deps } = harness(
      {},
      {
        writeKeyFile: () => {
          throw new Error('EACCES: permission denied');
        },
      },
    );
    expect(() => loadBootConfig(deps)).toThrow(
      /cannot write the generated key file "\/data\/master.key": EACCES/,
    );
  });

  it('deletes the secret variables from the environment once loaded, the _FILE path included', () => {
    const { deps, env } = harness({}, { scrub: true });
    loadBootConfig(deps);
    expect(env.VAUBAAN_MASTER_KEY_FILE).toBeUndefined();
    expect(env.VAUBAAN_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(env.VAUBAAN_STORE_PATH).toBe(STORE);
  });

  it('writes a key the loader accepts (the generator and the loader agree on the format)', () => {
    const text = generateMasterKeyText();
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_MASTER_KEY: undefined, VAUBAAN_MASTER_KEY_FILE: KEY_FILE }),
      readFile: fakeFiles({ [KEY_FILE]: text }),
    });
    expect(Buffer.from(config.encryption.masterKey).toString('base64')).toBe(text.trim());
  });
});
