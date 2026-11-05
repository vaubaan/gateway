/**
 * `plugins.*` and `updates.*` (spec §4.3; ADR plugins-bundled-or-pinned-by-the-operator):
 * no plugins directory and every plugin by default, the versions check on against the
 * project's feed; a malformed id or a feed that is not https is refused at load.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './errors';
import { loadInstanceConfig } from './load';
import { DEFAULT_UPDATES_FEED_URL } from './updates-default';
import { validEnv } from '../../../tests/support/config/testing';

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadInstanceConfig({ env });
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((issue) => issue.path);
    throw err;
  }
  throw new Error('expected the configuration to be refused');
}

describe('plugins.*', () => {
  it('pins nothing and registers every plugin by default', () => {
    const { config } = loadInstanceConfig({ env: validEnv() });
    expect(config.plugins).toEqual({ dir: null, enabled: null });
  });

  it('reads the directory and the enabled ids, once each', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_PLUGINS_DIR: '/plugins',
        VAUBAAN_PLUGINS_ENABLED: 'github, notion,github',
      }),
    });
    expect(config.plugins).toEqual({ dir: '/plugins', enabled: ['github', 'notion'] });
  });

  it('reads a blank list as unset: every plugin', () => {
    const { config } = loadInstanceConfig({ env: validEnv({ VAUBAAN_PLUGINS_ENABLED: ' ' }) });
    expect(config.plugins.enabled).toBeNull();
  });

  it('refuses an entry that is not a plugin id', () => {
    expect(issuesOf(validEnv({ VAUBAAN_PLUGINS_ENABLED: 'github,Notion' }))).toEqual([
      'plugins.enabled',
    ]);
  });
});

describe('updates.*', () => {
  it('checks the project feed by default', () => {
    const { config } = loadInstanceConfig({ env: validEnv() });
    expect(config.updates.check).toBe(true);
    expect(config.updates.feedUrl.href).toBe(DEFAULT_UPDATES_FEED_URL);
  });

  it('can be turned off and pointed at another https feed', () => {
    const { config } = loadInstanceConfig({
      env: validEnv({
        VAUBAAN_UPDATES_CHECK: 'false',
        VAUBAAN_UPDATES_FEED_URL: 'https://mirror.example.com/versions.json',
      }),
    });
    expect(config.updates.check).toBe(false);
    expect(config.updates.feedUrl.host).toBe('mirror.example.com');
  });

  it('refuses a feed that is not https', () => {
    expect(
      issuesOf(validEnv({ VAUBAAN_UPDATES_FEED_URL: 'http://mirror.example.com/versions.json' })),
    ).toEqual(['updates.feed_url']);
  });
});
