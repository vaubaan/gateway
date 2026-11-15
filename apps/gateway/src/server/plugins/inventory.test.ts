/**
 * The composition of bundled plugins, pins and `plugins.enabled`, and the accounts
 * check (ADR plugins-bundled-or-pinned-by-the-operator). Pure: the plugins are stubs.
 */
import type { ServicePlugin } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../config';
import {
  bundledInventory,
  checkAccountsServed,
  composePlugins,
  unservedServices,
} from './inventory';
import type { PinnedPlugin } from './loader';

function plugin(id: string, version: string): ServicePlugin {
  return { id, version, displayName: id.toUpperCase() } as unknown as ServicePlugin;
}

function pinOf(id: string, version: string, path = `/plugins/${id}`): PinnedPlugin {
  return { id, version, path, sdkRange: '^0.6.0', plugin: plugin(id, version) };
}

const BUNDLED = [plugin('github', '5.0.0'), plugin('notion', '0.2.0'), plugin('miro', '0.5.0')];

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('composePlugins', () => {
  it('registers every bundled plugin when nothing is pinned or filtered', () => {
    const set = composePlugins({ bundled: BUNDLED, pinned: [], enabled: null });
    expect(set.plugins.map((p) => p.id)).toEqual(['github', 'notion', 'miro']);
    expect(set.inventory).toEqual(bundledInventory(BUNDLED));
    expect(set.inventory[0]).toEqual({
      id: 'github',
      name: 'GITHUB',
      version: '5.0.0',
      origin: 'bundled',
      replaces: null,
      enabled: true,
      path: null,
    });
  });

  it('lets a pin replace the bundled plugin of its id in place, ahead or behind', () => {
    const set = composePlugins({
      bundled: BUNDLED,
      pinned: [pinOf('notion', '0.3.0'), pinOf('github', '4.2.0')],
      enabled: null,
    });
    expect(set.plugins.map((p) => `${p.id}@${p.version}`)).toEqual([
      'github@4.2.0',
      'notion@0.3.0',
      'miro@0.5.0',
    ]);
    expect(set.inventory.filter((e) => e.origin === 'pinned')).toEqual([
      {
        id: 'github',
        name: 'GITHUB',
        version: '4.2.0',
        origin: 'pinned',
        replaces: '5.0.0',
        enabled: true,
        path: '/plugins/github',
      },
      {
        id: 'notion',
        name: 'NOTION',
        version: '0.3.0',
        origin: 'pinned',
        replaces: '0.2.0',
        enabled: true,
        path: '/plugins/notion',
      },
    ]);
  });

  it('adds the pins of plugins the image does not bundle after the bundled ones, by id', () => {
    const set = composePlugins({
      bundled: BUNDLED,
      pinned: [pinOf('zendesk', '0.1.0'), pinOf('acme', '1.0.0')],
      enabled: null,
    });
    expect(set.plugins.map((p) => p.id)).toEqual(['github', 'notion', 'miro', 'acme', 'zendesk']);
    expect(set.inventory.find((e) => e.id === 'acme')?.replaces).toBeNull();
  });

  it('registers only what plugins.enabled lists, and keeps the others in the inventory', () => {
    const set = composePlugins({
      bundled: BUNDLED,
      pinned: [pinOf('acme', '1.0.0')],
      enabled: ['acme', 'notion'],
    });
    expect(set.plugins.map((p) => p.id)).toEqual(['notion', 'acme']);
    expect(set.inventory.map((e) => [e.id, e.enabled])).toEqual([
      ['github', false],
      ['notion', true],
      ['miro', false],
      ['acme', true],
    ]);
  });

  it('refuses an enabled id no plugin has, naming the known ids', () => {
    const message = messageOf(() =>
      composePlugins({ bundled: BUNDLED, pinned: [], enabled: ['notion', 'jira'] }),
    );
    expect(message).toContain('plugins.enabled');
    expect(message).toContain(`'jira' is not a plugin of this instance`);
    expect(message).toContain('known: github, notion, miro');
  });

  it('refuses two pins of one id', () => {
    const message = messageOf(() =>
      composePlugins({
        bundled: BUNDLED,
        pinned: [pinOf('notion', '0.3.0', '/plugins/a'), pinOf('notion', '0.4.0', '/plugins/b')],
        enabled: null,
      }),
    );
    expect(message).toContain(`/plugins/b: pins plugin 'notion' again (also in /plugins/a)`);
  });
});

describe('the accounts check', () => {
  const set = composePlugins({ bundled: BUNDLED, pinned: [], enabled: ['github'] });
  const registered = new Set(set.plugins.map((p) => p.id));

  it('passes when every service with accounts is registered', () => {
    expect(unservedServices({ github: 3 }, registered, set.inventory)).toEqual([]);
    expect(() => checkAccountsServed([])).not.toThrow();
  });

  it('names a disabled plugin and a missing one, with their counts', () => {
    const unserved = unservedServices(
      { github: 2, notion: 1, railway: 4, miro: 0 },
      registered,
      set.inventory,
    );
    expect(unserved).toEqual([
      { service: 'notion', accounts: 1, cause: 'disabled' },
      { service: 'railway', accounts: 4, cause: 'missing' },
    ]);
    const message = messageOf(() => checkAccountsServed(unserved));
    expect(message).toContain(`the store holds 1 account of 'notion'`);
    expect(message).toContain('plugins.enabled leaves the plugin out');
    expect(message).toContain(`the store holds 4 accounts of 'railway'`);
    expect(message).toContain('no plugin of this image or of the plugins directory serves it');
  });
});
