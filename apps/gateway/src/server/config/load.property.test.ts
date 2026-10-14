/**
 * Property-based tests of the configuration loader. The operator writes the
 * YAML file and the environment, but a typo, a paste of the wrong file or a
 * hostile template must still end in the one documented outcome: a
 * configuration, or a ConfigError naming the keys (exit 78) — never a
 * TypeError at boot, never a polluted prototype.
 *
 * Seeded and replayable (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import fc from 'fast-check';
import { dump } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { propertyRuns } from '@vaubaan/plugin-sdk/testing';

import { parseDuration } from './duration';
import { ConfigError } from './errors';
import { loadInstanceConfig } from './load';
import { fakeFiles, validEnv } from './testing';

const FILE = '/config/gateway.yaml';

/** Keys the loader knows, a few it does not, and the ones a prototype attack uses. */
const key = fc.constantFrom(
  'public_url',
  'store',
  'path',
  'encryption',
  'master_key',
  'previous_keys',
  'key_version',
  'admin',
  'emails',
  'group',
  'idp',
  'issuer',
  'sign_in',
  'github',
  'providers',
  'oauth',
  'telemetry',
  'enabled',
  'retention_days',
  'trusted_proxies',
  'unknown_key',
  '__proto__',
  'constructor',
  'prototype',
);
const scalar = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constantFrom(
    '${VAUBAAN_MASTER_KEY}',
    '${file:/run/secrets/x}',
    '${',
    '30s',
    '-1d',
    'https://x',
  ),
);
const tree = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    scalar,
    fc.array(tie('node'), { maxLength: 3 }),
    fc.dictionary(key, tie('node'), { maxKeys: 5 }),
  ),
})).node;

const yamlText = fc.oneof(
  tree.map((value) => {
    try {
      return dump(value);
    } catch {
      return '';
    }
  }),
  fc.string({ maxLength: 200 }),
  fc.constantFrom('a: &x [*x]', '!!js/function "x"', '? [a]\n: b', '---\n---', 'a: !!binary AAAA'),
);

function load(text: string): void {
  loadInstanceConfig({
    env: validEnv({ VAUBAAN_CONFIG_FILE: FILE }),
    readFile: fakeFiles({ [FILE]: text }),
  });
}

describe('configuration loader — properties', () => {
  it('any YAML file ends in a configuration or a ConfigError, and pollutes nothing', () => {
    fc.assert(
      fc.property(yamlText, (text) => {
        try {
          load(text);
        } catch (err) {
          expect(err, String(err)).toBeInstanceOf(ConfigError);
        }
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype).not.toHaveProperty('master_key');
      }),
      propertyRuns(),
    );
  });

  it('any environment value ends in a configuration or a ConfigError', () => {
    const name = fc.constantFrom(
      'VAUBAAN_PUBLIC_URL',
      'VAUBAAN_MASTER_KEY',
      'VAUBAAN_RETENTION_DAYS',
      'VAUBAAN_TRUSTED_PROXIES',
      'VAUBAAN_ADMIN_EMAILS',
      'VAUBAAN_TELEMETRY_ENABLED',
      'VAUBAAN_OAUTH_ACCESS_TOKEN_TTL',
      'VAUBAAN_SIGN_IN_X_KIND',
      'VAUBAAN_PROVIDER_GITHUB_APP_ID',
      'VAUBAAN_MASTER_KEY_FILE',
      'VAUBAAN_SIGN_IN___PROTO___KIND',
      'VAUBAAN_PROVIDER___PROTO___APP_ID',
      'VAUBAAN_SIGN_IN_CONSTRUCTOR_CLIENT_ID',
    );
    fc.assert(
      fc.property(
        fc.dictionary(name, fc.string({ maxLength: 60 }), { maxKeys: 4 }),
        (overrides) => {
          try {
            loadInstanceConfig({ env: validEnv(overrides), readFile: fakeFiles({}) });
          } catch (err) {
            expect(err, String(err)).toBeInstanceOf(ConfigError);
          }
        },
      ),
      propertyRuns(),
    );
  });

  // The counter-examples the properties found on their first run, kept as cases.
  it.each([
    ['an alias inside its own anchor', 'a: &x [*x]\n', 'refers to itself'],
    ['a __proto__ key', 'retention_days:\n  __proto__: null\n', 'is not a configuration key'],
  ])('%s is a ConfigError naming the key', (_, text, message) => {
    let error: unknown;
    try {
      load(text);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String((error as Error).message)).toContain(message);
  });

  it('a duration too long to count in seconds is not a duration', () => {
    expect(parseDuration('300000000000d')).toBeNull();
    expect(parseDuration('104249991374d')).toBe(104249991374 * 86_400);
  });

  it('a duration is a positive whole number of seconds, or null', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 24 }), fc.stringMatching(/^\s*\d{1,20}[smhdx]?\s*$/)),
        (text) => {
          const seconds = parseDuration(text);
          if (seconds !== null) {
            expect(Number.isSafeInteger(seconds)).toBe(true);
            expect(seconds).toBeGreaterThan(0);
          }
        },
      ),
      propertyRuns(),
    );
  });
});
