import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginRegistry, ServicePlugin } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_PLUGINS } from '../../../tests/support/plugins/repository';
import { BUNDLED_PLUGINS_DIR, connectFileUrl, readConnectFile } from './connect-files';
import { bundledInventory, type PluginInventoryEntry } from './inventory';

const CLOUDFLARE = REPOSITORY_PLUGINS.find((p) => p.id === 'cloudflare-dns') as ServicePlugin;
const FILE = 'create-token.webp';

function registryOf(plugins: readonly ServicePlugin[]): PluginRegistry {
  return {
    get: (id: string) => {
      const plugin = plugins.find((p) => p.id === id);
      return plugin ? { plugin } : undefined;
    },
  } as unknown as PluginRegistry;
}

const registry = registryOf([CLOUDFLARE]);
const bundled = bundledInventory([CLOUDFLARE]);

describe('the screenshots of a connect guide', () => {
  it('serves a file the guide declares, from the bundled plugin folder', async () => {
    const found = await readConnectFile({ registry, inventory: bundled }, 'cloudflare-dns', FILE);
    expect(found?.contentType).toBe('image/webp');
    expect(found?.body.byteLength).toBeGreaterThan(0);
    expect(BUNDLED_PLUGINS_DIR).toMatch(/plugins$/);
  });

  it('reads a pinned plugin from its own directory', async () => {
    const pin = mkdtempSync(join(tmpdir(), 'pin-'));
    mkdirSync(join(pin, 'docs', 'connect'), { recursive: true });
    copyFileSync(
      join(BUNDLED_PLUGINS_DIR, 'cloudflare-dns', 'docs', 'connect', FILE),
      join(pin, 'docs', 'connect', FILE),
    );
    const pinned: PluginInventoryEntry[] = [
      { ...bundled[0]!, origin: 'pinned', path: pin, replaces: '1.0.0' },
    ];
    const sources = { registry, inventory: pinned, bundledDir: '/nowhere' };
    expect(await readConnectFile(sources, 'cloudflare-dns', FILE)).not.toBeNull();
  });

  it.each([
    ['a name the guide does not declare', 'cloudflare-dns', 'other.webp'],
    ['a name outside the pattern', 'cloudflare-dns', '../risk-catalog.yaml'],
    ['a path', 'cloudflare-dns', '..%2Fpackage.json'],
    ['an unknown plugin', 'nope', FILE],
  ])('answers nothing for %s', async (_case, id, file) => {
    expect(await readConnectFile({ registry, inventory: bundled }, id, file)).toBeNull();
  });

  it('answers nothing for a plugin left out of plugins.enabled', async () => {
    const disabled = bundled.map((entry) => ({ ...entry, enabled: false }));
    expect(
      await readConnectFile({ registry, inventory: disabled }, 'cloudflare-dns', FILE),
    ).toBeNull();
  });

  it('names the route the connect page loads it from', () => {
    expect(connectFileUrl('cloudflare-dns', FILE)).toBe(
      '/reference/cloudflare-dns/connect/create-token.webp',
    );
  });
});
