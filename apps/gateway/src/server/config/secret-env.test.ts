import { afterEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig, loadProcessConfig, scrubSecretEnv } from './load';
import { CONFIG_FILE_ENV, isSecretKeyPath, secretEnvVariables } from './sources';
import { TEST_MASTER_KEY, fakeFiles, validEnv } from '../../../tests/support/config/testing';

describe('secret variables leave the environment once loaded (H3)', () => {
  it('names every secret key of the table, the sign-in secrets, their _FILE siblings, and every retired provider variable', () => {
    const env = validEnv({
      VAUBAAN_MASTER_KEY_PREVIOUS: `1=${TEST_MASTER_KEY}`,
      VAUBAAN_SIGN_IN_GITHUB_KIND: 'github',
      VAUBAAN_SIGN_IN_GITHUB_CLIENT_ID: 'Ov23liExample',
      VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET_FILE: '/run/secrets/gh',
      VAUBAAN_PROVIDER_GMAIL_CLIENT_ID: '12345',
      VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET: 'gsecret',
      VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_SECRET: 'cf',
    });
    expect(secretEnvVariables(env)).toEqual([
      'VAUBAAN_BOOTSTRAP_TOKEN',
      'VAUBAAN_MASTER_KEY',
      'VAUBAAN_MASTER_KEY_PREVIOUS',
      // Retired (no longer read): taken out of the environment whatever the field.
      'VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_SECRET',
      'VAUBAAN_PROVIDER_GMAIL_CLIENT_ID',
      'VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET',
      'VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET_FILE',
    ]);
  });

  it('classifies configuration paths', () => {
    expect(isSecretKeyPath('encryption.master_key')).toBe(true);
    expect(isSecretKeyPath('encryption.previous_keys.3')).toBe(true);
    expect(isSecretKeyPath('bootstrap_token')).toBe(true);
    expect(isSecretKeyPath('sign_in.entra.client_secret')).toBe(true);
    // The retired block is never read; whatever it references is treated as a secret's.
    expect(isSecretKeyPath('providers.gmail.client_secret')).toBe(true);
    expect(isSecretKeyPath('providers.gmail.client_id')).toBe(true);
    expect(isSecretKeyPath('sign_in.entra.client_id')).toBe(false);
    expect(isSecretKeyPath('public_url')).toBe(false);
  });

  it('adds the variables a YAML file references at a secret key, not the others', () => {
    const yaml = [
      'public_url: ${PUBLIC_ORIGIN}',
      'store:',
      '  path: /data/gateway.db',
      'encryption:',
      '  master_key: ${MASTER}',
      'admin:',
      '  emails: [ops@example.com]',
      'bootstrap_token: ${BOOT}',
    ].join('\n');
    const loaded = loadInstanceConfig({
      env: {
        [CONFIG_FILE_ENV]: '/config/gateway.yaml',
        MASTER: TEST_MASTER_KEY,
        BOOT: 'b'.repeat(40),
        PUBLIC_ORIGIN: 'https://gateway.example.com',
      },
      readFile: fakeFiles({ '/config/gateway.yaml': yaml }),
    });
    expect(loaded.secretEnvNames).toEqual(['BOOT', 'MASTER']);
  });

  it('scrubSecretEnv deletes the names it is given and nothing else', () => {
    const env: Record<string, string | undefined> = { A: '1', B: '2', C: '3' };
    scrubSecretEnv(env, ['A', 'C', 'MISSING']);
    expect(env).toEqual({ B: '2' });
  });

  describe('loadProcessConfig', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name];
      }
      Object.assign(process.env, saved);
    });

    it('keeps the secrets in the configuration and removes them from process.env', () => {
      Object.assign(process.env, validEnv());
      const { config } = loadProcessConfig();
      expect(config.bootstrapToken).not.toBeNull();
      expect(config.encryption.masterKey).toHaveLength(32);
      expect(process.env.VAUBAAN_MASTER_KEY).toBeUndefined();
      expect(process.env.VAUBAAN_BOOTSTRAP_TOKEN).toBeUndefined();
      expect(process.env.VAUBAAN_PUBLIC_URL).toBe('https://gateway.example.com');
      expect(process.env.VAUBAAN_STORE_PATH).toBeDefined();
    });
  });
});
