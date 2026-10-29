/**
 * The plugin catalog of the site is the repository's `plugins/` folder:
 * every plugin folder is listed, the kit (`_template`) is not, and each is
 * read through its own entry module, as the gateway reads it.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { discoverPluginDirs, loadPlugins, type PluginInfo } from '../../../src/content/plugins';
import { REPO_ROOT } from '../../../src/content/repo';

const PLUGINS = join(REPO_ROOT, 'plugins');

/** Written independently of the code under test: a folder with a package.json. */
function pluginFolders(): string[] {
  return readdirSync(PLUGINS)
    .filter((name) => statSync(join(PLUGINS, name)).isDirectory())
    .filter((name) => existsSync(join(PLUGINS, name, 'package.json')));
}

let plugins: PluginInfo[] = [];

beforeAll(async () => {
  plugins = await loadPlugins(REPO_ROOT);
}, 60_000);

describe('the plugin catalog of the site', () => {
  it('lists every plugin folder of the repository but the kit', () => {
    const expected = pluginFolders()
      .filter((name) => name !== '_template')
      .map((name) => `plugins/${name}`)
      .sort();
    expect(discoverPluginDirs(REPO_ROOT)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('leaves out _template', () => {
    expect(pluginFolders()).toContain('_template');
    expect(discoverPluginDirs(REPO_ROOT)).not.toContain('plugins/_template');
    expect(plugins.map((p) => p.dir)).not.toContain('plugins/_template');
  });

  it('loads one plugin per folder, with its declaration and its catalog', () => {
    expect(plugins.map((p) => p.dir).sort()).toEqual(discoverPluginDirs(REPO_ROOT));
    expect(new Set(plugins.map((p) => p.id)).size).toBe(plugins.length);
    for (const plugin of plugins) {
      expect(plugin.version, plugin.id).toMatch(/^\d+\.\d+\.\d+/);
      expect(plugin.name, plugin.id).not.toBe('');
      expect(plugin.risks.length, plugin.id).toBeGreaterThan(0);
      expect(plugin.presets.length, plugin.id).toBeGreaterThan(0);
      expect(plugin.credentials.length, plugin.id).toBeGreaterThan(0);
      for (const risk of plugin.risks) {
        expect(risk.id.startsWith(plugin.id), risk.id).toBe(true);
        expect(['low', 'medium', 'high', 'critical']).toContain(risk.severity);
      }
      const ids = new Set(plugin.risks.map((r) => r.id.replace(/\[[^\]]+\]/, '')));
      for (const preset of plugin.presets) {
        for (const entry of preset.entries) {
          expect(ids.has(entry.riskId.replace(/\[[^\]]+\]/, '')), entry.riskId).toBe(true);
        }
      }
    }
  });

  it('carries no experimental state (docs/handbook/plugin-sdk.md)', () => {
    for (const plugin of plugins) expect(plugin, plugin.id).not.toHaveProperty('experimental');
  });
});
