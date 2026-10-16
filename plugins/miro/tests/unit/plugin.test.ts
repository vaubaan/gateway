/**
 * Mandatory suite of the `miro` plugin : the SDK kit (definition, presets,
 * no wildcard, catalog coverage, identifier proof), the identity, the
 * version, the catalog path. No network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
} from '@vaubaan/plugin-sdk/testing';

import { ACCESS_TOKEN_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { miroCatalog, miroPlugin } from '../../src/index.ts';
import { SAMPLES, context, workshop } from './fixtures.ts';

describe('miro plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(miroPlugin);
    assertPresetsValid(miroPlugin);
    assertNoWildcard(miroPlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(miroPlugin, SAMPLES, { resources: [workshop] });
    const named = miroCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(report.risksTouched).toEqual(named);
    expect(report.risksTouched).toHaveLength(6);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(miroPlugin, SAMPLES, {
      resources: [workshop],
      context: (fetch, resources) => context(fetch, resources),
    });
    expect(report.toolsChecked).toBe(miroPlugin.tools.length);
    // Item, frame, connector ids are segments of the request path ; the board travels
    // %3D-encoded and has its own cases (identifiers.test.ts).
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getItem, argument: 'item_id' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.deleteFrame, argument: 'frame_id' });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getConnector,
      argument: 'connector_id',
    });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(miroCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(miroCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and every tool has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(miroPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(miroPlugin.tools).toHaveLength(30);
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(miroPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
    expect(miroPlugin.credential).toMatchObject({
      kind: 'api-key',
      fields: [{ name: ACCESS_TOKEN_FIELD, secret: true }],
    });
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(miroPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ name: '@vaubaan/plugin-miro', version: miroPlugin.version });
  });

  test('no environment anywhere : no envScopable entity, no env-scoped risk', () => {
    const entities = miroPlugin.dataModel.planes.flatMap((p) => p.entities);
    expect(entities.some((e) => e.envScopable === true)).toBe(false);
    for (const risk of miroCatalog.catalog.risks) {
      expect(risk.acceptable_in_envs, risk.id).toBeUndefined();
    }
    for (const preset of miroCatalog.catalog.presets ?? []) {
      for (const entry of preset.entries) expect(entry.risk_id).not.toMatch(/\[/);
    }
  });
});
