// The pinnable bundles (ADR plugins-bundled-or-pinned-by-the-operator): every
// bundleable plugin builds, imports under plain Node as a plugin of its id and
// version (the script's smoke test), and loads through the gateway's own loader of
// the plugins directory; a plugin that declares itself not bundleable is skipped.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readPinnedPlugins } from '../apps/gateway/src/server/plugins/loader.ts';
import {
  BundleError,
  allPluginIds,
  buildPluginBundle,
  bundleManifest,
  notBundleableReason,
  parseArguments,
} from './build-plugin-bundle.mjs';

const SDK_VERSION = JSON.parse(
  readFileSync(new URL('../packages/plugin-sdk/package.json', import.meta.url), 'utf8'),
).version;

describe('build-plugin-bundle', () => {
  let out;
  const results = [];

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'vaubaan-bundles-'));
    for (const id of allPluginIds()) {
      results.push(await buildPluginBundle(id, { out, sdkVersion: SDK_VERSION, esbuild }));
    }
  }, 120_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('builds and imports every bundleable plugin, and says why the others are skipped', () => {
    expect(results.length).toBeGreaterThan(10);
    for (const result of results) {
      if ('skipped' in result) {
        expect(result.skipped.length, result.id).toBeGreaterThan(10);
        continue;
      }
      const manifest = JSON.parse(readFileSync(join(result.path, 'package.json'), 'utf8'));
      expect(manifest).toMatchObject({
        name: `@vaubaan/plugin-${result.id}`,
        version: result.version,
        type: 'module',
        exports: { '.': './index.js' },
        peerDependencies: { '@vaubaan/plugin-sdk': `^${SDK_VERSION}` },
        license: 'Apache-2.0',
      });
      expect(readFileSync(join(result.path, 'risk-catalog.yaml'), 'utf8')).toContain('risks');
      const archive = JSON.parse(readFileSync(join(result.path, 'vaubaan-manifest.json'), 'utf8'));
      expect(archive).toMatchObject({ id: result.id, version: result.version });
      expect(Object.keys(archive.files)).toEqual(
        expect.arrayContaining(['index.js', 'package.json', 'risk-catalog.yaml', 'LICENSE']),
      );
    }
    expect(results.find((r) => r.id === 'ssh')).toMatchObject({ skipped: expect.any(String) });
  });

  it('writes bundles the gateway loads from its plugins directory', async () => {
    const pins = await readPinnedPlugins(out, { sdkVersion: SDK_VERSION });
    /** @type {string[]} */
    const built = results
      .filter((r) => !('skipped' in r))
      .map((r) => `${r.id}@${r.version}`)
      .sort();
    // Both sides sorted as `id@version` strings : the loader orders by id, and an id
    // that is a prefix of another (`github`, `github-projects`) sorts apart.
    expect(pins.map((pin) => `${pin.id}@${pin.version}`).sort()).toEqual(built);
  }, 60_000);
});

describe('bundle manifest and arguments', () => {
  it('names the plugin and its SDK range', () => {
    expect(
      bundleManifest({ name: 'x', version: '1.2.3', description: 'd' }, 'acme', '0.6.0'),
    ).toEqual({
      name: '@vaubaan/plugin-acme',
      version: '1.2.3',
      description: 'd',
      type: 'module',
      exports: { '.': './index.js' },
      peerDependencies: { '@vaubaan/plugin-sdk': '^0.6.0' },
      license: 'Apache-2.0',
    });
  });

  it('reads the bundleable flag', () => {
    expect(notBundleableReason({})).toBeNull();
    expect(notBundleableReason({ vaubaan: { bundleable: true } })).toBeNull();
    expect(notBundleableReason({ vaubaan: { bundleable: false, reason: 'native addon' } })).toBe(
      'native addon',
    );
    expect(notBundleableReason({ vaubaan: { bundleable: false } })).toBe('declared not bundleable');
  });

  it('takes ids or --all, and --out', () => {
    expect(parseArguments(['notion', 'miro', '--out', 'x'])).toEqual({
      ids: ['notion', 'miro'],
      out: 'x',
      all: false,
    });
    expect(parseArguments(['--all']).all).toBe(true);
    expect(() => parseArguments([])).toThrow(BundleError);
    expect(() => parseArguments(['--all', 'notion'])).toThrow(BundleError);
    expect(() => parseArguments(['--bogus', 'x'])).toThrow(BundleError);
  });
});
