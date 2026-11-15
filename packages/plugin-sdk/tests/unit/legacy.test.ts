/**
 * A plugin built against an SDK before 0.9.4 says provider where this SDK says service
 * (ADR one-word-per-thing-account-service-plugin, rename R2). `fromLegacyPlugin` puts it in
 * this SDK's words both ways, and the catalog loader reads a `provider:` key as `service:`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { Resource } from '@vaubaan/shared';

import { parseCatalogYaml } from '../../src/catalog-loader.ts';
import { fromLegacyPlugin, isLegacyPlugin } from '../../src/legacy.ts';
import type { ServicePlugin } from '../../src/plugin.ts';
import { createRegistry } from '../../src/registry.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

/** What a 0.9.3 bundle of the Acme plugin hands the host: `provider` everywhere. */
function legacyAcme(seen: { resources?: readonly unknown[] }): ServicePlugin {
  const { service, ...catalog } = acmePlugin.catalog;
  const { service: modelService, ...dataModel } = acmePlugin.dataModel;
  const legacy = {
    ...acmePlugin,
    catalog: { ...catalog, provider: service },
    dataModel: { ...dataModel, provider: modelService },
    credential: {
      ...acmePlugin.credential,
      guide: {
        ...(acmePlugin.credential as { guide?: object }).guide,
        expiry: { kind: 'provider-reports' },
      },
    },
    classify: (
      tool: string,
      args: Readonly<Record<string, unknown>>,
      resources: readonly Resource[],
    ) => {
      seen.resources = resources;
      const outcome = acmePlugin.classify(tool, args, resources);
      return 'slices' in outcome
        ? {
            slices: outcome.slices.map(({ service: s, ...rest }) => ({ ...rest, provider: s })),
          }
        : outcome;
    },
    discoverResources: () =>
      Promise.resolve([{ provider: 'acme', ref: 'sp-1', displayName: 'Space one' }]),
  };
  return legacy as unknown as ServicePlugin;
}

describe('a plugin of an SDK before 0.9.4', () => {
  test('is recognised by its catalog, and a plugin of this SDK is returned as it is', () => {
    expect(isLegacyPlugin(legacyAcme({}))).toBe(true);
    expect(isLegacyPlugin(acmePlugin)).toBe(false);
    expect(fromLegacyPlugin(acmePlugin)).toBe(acmePlugin);
  });

  test('declares and returns service, and registers', async () => {
    const seen: { resources?: readonly unknown[] } = {};
    const plugin = fromLegacyPlugin(legacyAcme(seen));
    expect(plugin.catalog.service).toBe('acme');
    expect(plugin.catalog).not.toHaveProperty('provider');
    expect(plugin.dataModel.service).toBe('acme');
    expect(JSON.stringify(plugin.credential)).toContain('"service-reports"');
    expect(() => createRegistry([plugin])).not.toThrow();

    const outcome = plugin.classify('acme__list_things', { space: 'sp-1' }, [
      { service: 'acme', ref: 'sp-1', displayName: 'Space one' },
    ]);
    expect(outcome).toEqual({
      slices: [expect.objectContaining({ service: 'acme' })],
    });
    expect('slices' in outcome && outcome.slices[0]).not.toHaveProperty('provider');
    // What the host hands it still carries the field it reads.
    expect(seen.resources).toEqual([
      { service: 'acme', provider: 'acme', ref: 'sp-1', displayName: 'Space one' },
    ]);

    const discovered = await plugin.discoverResources({
      credential: { kind: 'api-key', fields: { api_key: 'k' }, metadata: {} },
      fetch: () => Promise.reject(new Error('no network')),
    });
    expect(discovered).toEqual([{ service: 'acme', ref: 'sp-1', displayName: 'Space one' }]);
  });
});

describe('a catalog that still names its provider', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL('../fixtures/acme/risk-catalog.yaml', import.meta.url)),
    'utf8',
  );

  test('loads, read as service', () => {
    const deprecated = parseCatalogYaml(fixture.replace(/^service: acme$/m, 'provider: acme'));
    expect(deprecated.catalog).toEqual(parseCatalogYaml(fixture).catalog);
    expect(deprecated.catalog.service).toBe('acme');
  });

  test('refuses both keys at once', () => {
    expect(() =>
      parseCatalogYaml(fixture.replace(/^service: acme$/m, 'service: acme\nprovider: acme')),
    ).toThrow(/provider: the former name of service/);
  });
});
