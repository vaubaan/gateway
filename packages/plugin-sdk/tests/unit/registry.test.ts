import { describe, expect, test } from 'vitest';

import {
  PluginRegistry,
  PluginRegistryError,
  createRegistry,
  serviceIconOf,
} from '../../src/registry.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { acmePlugin, acmeTools } from '../fixtures/acme/acme-plugin.ts';

/** A second valid plugin, derived from acme with another id. */
function cloneAs(id: string, overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
  const prefix = `${id.replaceAll('-', '_')}__`;
  const rename = (s: string) =>
    s.replace(/^acme/, id).replaceAll('acme.', `${id}.`).replaceAll('acme[', `${id}[`);
  return {
    ...acmePlugin,
    id,
    displayName: id.toUpperCase(),
    tools: acmeTools.map((t) => ({ ...t, name: t.name.replace('acme__', prefix) })),
    dataModel: { ...acmePlugin.dataModel, provider: id },
    catalog: {
      ...acmePlugin.catalog,
      provider: id,
      risks: acmePlugin.catalog.risks.map((r) => ({
        ...r,
        id: rename(r.id),
        matches: typeof r.matches === 'string' ? rename(r.matches) : r.matches.map(rename),
        ...(r.replaced_by ? { replaced_by: rename(r.replaced_by) } : {}),
      })),
      macro_actions: (acmePlugin.catalog.macro_actions ?? []).map((a) => ({
        ...a,
        entries: a.entries.map((e) => ({ ...e, risk_id: rename(e.risk_id) })),
      })),
    },
    ...overrides,
  };
}

const beta = cloneAs('beta-cloud');

describe('PluginRegistry — derivations', () => {
  const registry = createRegistry([acmePlugin, beta]);

  test('ids in registration order, size, has/get/require', () => {
    expect(registry.ids).toEqual(['acme', 'beta-cloud']);
    expect(registry.size).toBe(2);
    expect(registry.has('acme')).toBe(true);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.require('beta-cloud').plugin.displayName).toBe('BETA-CLOUD');
    expect(() => registry.require('nope')).toThrow(
      /Unknown provider 'nope' \(known: acme, beta-cloud\)/,
    );
  });

  test('providerForTool: exact name, prefix rule for unlisted tools, null otherwise', () => {
    expect(registry.providerForTool('acme__list_things')?.plugin.id).toBe('acme');
    expect(registry.providerForTool('beta_cloud__update_thing')?.plugin.id).toBe('beta-cloud');
    expect(registry.providerForTool('beta_cloud__not_declared')?.plugin.id).toBe('beta-cloud');
    expect(registry.providerForTool('gamma__x')).toBeNull();
    expect(registry.providerForTool('no_separator')).toBeNull();
  });

  test('toolDeclarations concatenates every plugin', () => {
    expect(registry.toolDeclarations().map((t) => t.name)).toEqual([
      'acme__list_things',
      'acme__update_thing',
      'beta_cloud__list_things',
      'beta_cloud__update_thing',
    ]);
  });

  test('labels for the UI', () => {
    expect(registry.labels()).toEqual([
      {
        id: 'acme',
        displayName: 'Acme',
        version: '1.2.3',
        description: 'Fixture provider.',
        icon: null,
        summary: null,
      },
      {
        id: 'beta-cloud',
        displayName: 'BETA-CLOUD',
        version: '1.2.3',
        description: 'Fixture provider.',
        icon: null,
        summary: null,
      },
    ]);
  });

  test('labels carry the summary of the provider reference when the plugin has one', () => {
    const withSummary = new PluginRegistry([
      { ...acmePlugin, summary: 'One connection is one Acme account.' },
    ]);
    expect(withSummary.labels()[0]?.summary).toBe('One connection is one Acme account.');
  });

  test('labels carry the icon of the service when the plugin declares one, with its colour', () => {
    const withIcon = new PluginRegistry([{ ...acmePlugin, icon: 'M12 2 22 22H2Z' }]);
    expect(withIcon.labels()[0]?.icon).toEqual({ path: 'M12 2 22 22H2Z', color: null });
    const coloured = new PluginRegistry([
      { ...acmePlugin, icon: 'M12 2 22 22H2Z', iconColor: '#635BFF' },
    ]);
    expect(coloured.labels()[0]?.icon).toEqual({ path: 'M12 2 22 22H2Z', color: '#635BFF' });
    // A colour without an icon draws nothing: no mark.
    expect(serviceIconOf({ iconColor: '#635BFF' })).toBeNull();
  });

  test('idEnum is a non-empty tuple', () => {
    expect(registry.idEnum()).toEqual(['acme', 'beta-cloud']);
    expect(() => new PluginRegistry([]).idEnum()).toThrow(/empty/);
  });

  test('catalogOf is indexed', () => {
    expect(registry.catalogOf('acme').entries).toHaveLength(4);
    expect(registry.catalogOf('beta-cloud').entries[1]!.entry.id).toBe('beta-cloud.thing-write');
  });

  test('registered plugin exposes its prefix and tool names', () => {
    const r = registry.require('beta-cloud');
    expect(r.toolPrefix).toBe('beta_cloud__');
    expect([...r.toolNames]).toEqual(['beta_cloud__list_things', 'beta_cloud__update_thing']);
  });

  test('brokerProviderOf / brokerProviders: the OAuth brokers the plugins need', () => {
    const brokered = (id: string) =>
      cloneAs(id, { credential: { kind: 'oauth2', broker: { provider: 'google' }, scopes: [] } });
    const withBrokers = createRegistry([acmePlugin, brokered('gamma'), brokered('delta')]);
    expect(withBrokers.brokerProviderOf('acme')).toBeNull();
    expect(withBrokers.brokerProviderOf('gamma')).toBe('google');
    expect(withBrokers.brokerProviders()).toEqual(['google']);
    expect(registry.brokerProviders()).toEqual([]);
  });
});

describe('PluginRegistry — conflicts', () => {
  test('the same id twice', () => {
    expect(() => createRegistry([acmePlugin, acmePlugin])).toThrow(PluginRegistryError);
    expect(() => createRegistry([acmePlugin, acmePlugin])).toThrow(/registered twice/);
  });

  test('a tool outside the plugin prefix is rejected before any cross-plugin check', () => {
    const legal = cloneAs('thief');
    const stolen: ProviderPlugin = {
      ...legal,
      tools: [...legal.tools, { ...acmeTools[0]!, name: 'acme__list_things' }],
    };
    expect(() => createRegistry([acmePlugin, stolen])).toThrow(
      /plugin 'thief': tools\[2\]\.name 'acme__list_things' must start with 'thief__'/,
    );
  });

  test('an ill-formed plugin is reported with its id', () => {
    const broken = cloneAs('broken', { version: 'latest' });
    expect(() => createRegistry([broken])).toThrow(/plugin 'broken': version: expected semver/);
  });
});
