/**
 * Mandatory suite of the `fly` plugin : the SDK kit (definition, macro-actions,
 * coverage of every tool, the identifier proof), identity and version.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import { SERVICE_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { flyCatalog, flyPlugin } from '../../src/index.ts';
import {
  acme,
  appIdentityRoute,
  canary,
  config,
  context,
  leaseRoutes,
  machineRoute,
} from './fixtures.ts';

/** The plugin's own samples (`src/examples.ts`), each with its resources. */
export const SAMPLES: ToolSamples = flyPlugin.examples;

describe('fly plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(flyPlugin);
    assertNoWildcard(flyPlugin);
  });

  test('every tool classifies to slices the catalog covers, every risk is reached, no fallback', () => {
    const report = assertCatalogCoverage(flyPlugin);
    // Paths only : this model's cardinalities count instances, not how a slice names them.
    assertSlicesOnDataModel(flyPlugin, SAMPLES, {
      resources: [acme, canary],
      cardinalities: false,
    });
    expect(report.toolsChecked).toBe(flyPlugin.tools.length);
    expect(report.fallbackHits).toEqual([]);
    expect(report.risksUntouched).toEqual([]);
    expect(report.risksTouched).toEqual(
      flyCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id),
    );
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(flyPlugin, SAMPLES, {
      resources: [acme, canary],
      routes: [appIdentityRoute(), machineRoute(config()), ...leaseRoutes],
      context: (fetch, resources) => context(fetch, resources),
      exempt: {
        [TOOL.execMachine]: { stdin: 'free text sent in the JSON body, never in a URL' },
      },
    });
    expect(report.toolsChecked).toBe(flyPlugin.tools.length);
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getMachine,
      argument: 'machine_id',
    });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getMachine, argument: 'app' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getVolume, argument: 'volume_id' });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getCertificate,
      argument: 'hostname',
    });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.unsetSecret, argument: 'name' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.releaseIp, argument: 'ip' });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(flyCatalog.catalog.service).toBe(SERVICE_ID);
    expect(flyCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${SERVICE_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the service id, once, and every tool has a title', () => {
    const prefix = toolPrefixFor(SERVICE_ID);
    expect(flyPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(flyPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
  });

  test('the secret values of set_secrets are declared for masking', () => {
    expect(flyPlugin.secretArguments).toEqual({ [TOOL.setSecrets]: ['values'] });
  });

  test('creating an app is declared as creating a resource, and nothing else is', () => {
    // An app is what discovery lists : after fly__create_app the host runs
    // discovery again (ADR created-resources-join-the-mission). A machine, a
    // volume or a certificate lives inside an app and creates no resource.
    expect(flyPlugin.resourceCreatingTools).toEqual([TOOL.createApp]);
    expect(flyPlugin.tools.map((t) => t.name)).toContain(TOOL.createApp);
  });

  test('the plugin is the default export', () => {
    expect(defaultExport).toBe(flyPlugin);
  });
});
