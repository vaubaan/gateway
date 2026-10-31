/**
 * `oauth_brokers.<name>.*` (ADR google-calendar-through-an-oauth-broker D1):
 * the brokers the instance is enrolled with, read from the file or the
 * environment, the key a secret like every other, and which broker serves a
 * broker provider.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import { loadInstanceConfig } from './load';
import { brokerFor, parseBrokerUrl } from './oauth-brokers';
import { envNamesFor, isSecretKeyPath, secretEnvVariables } from './sources';
import { fakeFiles, validEnv } from '../../../tests/support/config/testing';
import { secretValues, type OAuthBrokerConfig } from './types';

const KEY = 'broker-key-PLAINTEXT-0123456789';

function load(env: Record<string, string>, files?: Record<string, string>) {
  return loadInstanceConfig({ env: validEnv(env), readFile: files ? fakeFiles(files) : undefined })
    .config;
}

function problems(env: Record<string, string>, files?: Record<string, string>): string {
  try {
    load(env, files);
  } catch (err) {
    if (err instanceof ConfigError)
      return err.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    throw err;
  }
  throw new Error('the configuration loaded');
}

describe('OAuth brokers in the configuration', () => {
  it('has none by default', () => {
    expect(load({}).oauthBrokers).toEqual([]);
  });

  it('reads a broker from the environment, its key from a file, and redacts the key', () => {
    const config = load(
      {
        VAUBAAN_OAUTH_BROKER_MAIN_URL: 'https://broker.example.com/v1/',
        VAUBAAN_OAUTH_BROKER_MAIN_KEY_FILE: '/run/secrets/broker',
        VAUBAAN_OAUTH_BROKER_MAIN_PROVIDERS: 'Google',
      },
      { '/run/secrets/broker': `${KEY}\n` },
    );
    expect(config.oauthBrokers).toEqual([
      {
        name: 'main',
        url: new URL('https://broker.example.com/v1'),
        key: KEY,
        providers: ['google'],
        attestation: 'required',
      },
    ]);
    expect(secretValues(config)).toContain(KEY);
    expect(
      secretEnvVariables({
        VAUBAAN_OAUTH_BROKER_MAIN_KEY_FILE: '/x',
        VAUBAAN_OAUTH_BROKER_MAIN_URL: 'u',
      }),
    ).toEqual(['VAUBAAN_OAUTH_BROKER_MAIN_KEY_FILE']);
    expect(isSecretKeyPath('oauth_brokers.main.key')).toBe(true);
    expect(isSecretKeyPath('oauth_brokers.main.url')).toBe(false);
    expect(envNamesFor('oauth_brokers.eu-west.key')).toEqual([
      'VAUBAAN_OAUTH_BROKER_EU_WEST_KEY',
      'VAUBAAN_OAUTH_BROKER_EU_WEST_KEY_FILE',
    ]);
  });

  it('reads brokers from the file, a ${file:…} key included', () => {
    const yaml = [
      'oauth_brokers:',
      '  main:',
      '    url: https://broker.example.com',
      '    key: ${file:/run/secrets/broker}',
      '  europe:',
      '    url: https://eu.broker.example.com',
      '    key: other-key-value-0123456789',
      '    providers: [microsoft]',
    ].join('\n');
    const config = load(
      { VAUBAAN_CONFIG_FILE: '/c.yaml' },
      { '/c.yaml': yaml, '/run/secrets/broker': KEY },
    );
    expect(config.oauthBrokers.map((b) => [b.name, b.providers])).toEqual([
      ['main', []],
      ['europe', ['microsoft']],
    ]);
    expect(brokerFor(config.oauthBrokers, 'google')?.name).toBe('main');
    expect(brokerFor(config.oauthBrokers, 'microsoft')?.name).toBe('europe');
  });

  it('refuses a broker without url or key, a bad name, a URL that is not https', () => {
    expect(problems({ VAUBAAN_OAUTH_BROKER_MAIN_URL: 'https://broker.example.com' })).toMatch(
      /oauth_brokers\.main\.key/,
    );
    expect(
      problems({
        VAUBAAN_OAUTH_BROKER_MAIN_URL: 'http://broker.example.com',
        VAUBAAN_OAUTH_BROKER_MAIN_KEY: KEY,
      }),
    ).toMatch(/oauth_brokers\.main\.url: must use https/);
    expect(
      problems(
        { VAUBAAN_CONFIG_FILE: '/c.yaml' },
        { '/c.yaml': 'oauth_brokers:\n  Main:\n    url: https://b.example.com\n    key: k\n' },
      ),
    ).toMatch(/oauth_brokers\.Main: a broker name is/);
    expect(problems({ VAUBAAN_OAUTH_BROKER_MAIN_SECRET: 'x' })).toMatch(
      /does not end with a known OAuth broker field/,
    );
  });

  it('attests a broker unless it says attestation: none, and accepts no other value', () => {
    const base = {
      VAUBAAN_OAUTH_BROKER_MAIN_URL: 'https://broker.example.com',
      VAUBAAN_OAUTH_BROKER_MAIN_KEY: KEY,
    };
    expect(load(base).oauthBrokers[0]?.attestation).toBe('required');
    expect(
      load({ ...base, VAUBAAN_OAUTH_BROKER_MAIN_ATTESTATION: 'None' }).oauthBrokers[0]?.attestation,
    ).toBe('none');
    // No platform can be named, the test-only one included: the allowlist is the release's.
    for (const other of ['fake-enclave', 'gcp-confidential-space', 'off', '*']) {
      expect(problems({ ...base, VAUBAAN_OAUTH_BROKER_MAIN_ATTESTATION: other })).toMatch(
        /oauth_brokers\.main\.attestation: must be required or none/,
      );
    }
  });

  it('reaches an attested broker over https only: http on the loopback needs attestation: none', () => {
    const loopback = {
      VAUBAAN_OAUTH_BROKER_MAIN_URL: 'http://127.0.0.1:8080/v1',
      VAUBAAN_OAUTH_BROKER_MAIN_KEY: KEY,
    };
    expect(problems(loopback)).toMatch(
      /oauth_brokers\.main\.url: an attested broker is reached over https only/,
    );
    expect(
      load({ ...loopback, VAUBAAN_OAUTH_BROKER_MAIN_ATTESTATION: 'none' }).oauthBrokers[0]?.url
        .protocol,
    ).toBe('http:');
  });

  it('refuses two default brokers and a provider served twice', () => {
    const two = {
      VAUBAAN_OAUTH_BROKER_A_URL: 'https://a.example.com',
      VAUBAAN_OAUTH_BROKER_A_KEY: KEY,
      VAUBAAN_OAUTH_BROKER_B_URL: 'https://b.example.com',
      VAUBAAN_OAUTH_BROKER_B_KEY: KEY,
    };
    expect(problems(two)).toMatch(/oauth_brokers\.b\.providers: at most one broker/);
    expect(
      problems({
        ...two,
        VAUBAAN_OAUTH_BROKER_A_PROVIDERS: 'google',
        VAUBAAN_OAUTH_BROKER_B_PROVIDERS: 'google',
      }),
    ).toMatch(/provider "google" is already served by broker "a"/);
  });
});

describe('which broker serves a provider', () => {
  const broker = (name: string, providers: string[]): OAuthBrokerConfig => ({
    name,
    url: new URL(`https://${name}.example.com`),
    key: 'k',
    providers,
    attestation: 'required',
  });

  it('the one listing it, else the default broker, else none', () => {
    const brokers = [broker('dflt', []), broker('ms', ['microsoft'])];
    expect(brokerFor(brokers, 'microsoft')?.name).toBe('ms');
    expect(brokerFor(brokers, 'google')?.name).toBe('dflt');
    expect(brokerFor([broker('ms', ['microsoft'])], 'google')).toBeNull();
    expect(brokerFor([], 'google')).toBeNull();
  });

  it('accepts http on the loopback interface only, and no credentials or query in the URL', () => {
    expect(parseBrokerUrl('http://127.0.0.1:8080/v1')).toMatchObject({ ok: true });
    expect(parseBrokerUrl('http://broker.example.com')).toMatchObject({ ok: false });
    expect(parseBrokerUrl('https://u:p@broker.example.com')).toMatchObject({ ok: false });
    expect(parseBrokerUrl('https://broker.example.com/?x=1')).toMatchObject({ ok: false });
  });
});
