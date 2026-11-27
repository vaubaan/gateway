/**
 * Mandatory suite of the `google-drive` plugin: the SDK kit (definition,
 * macro-actions, no wildcard, catalog coverage, identifier proof), the
 * identity, the version, the catalog path, the credential and the tool
 * surface. No network.
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
  assertSlicesOnDataModel,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import { SCOPES, SERVICE_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { googleDriveCatalog, googleDrivePlugin } from '../../src/index.ts';
import { ANY_DRIVE, SAMPLES, alice, context } from './fixtures.ts';

describe('google-drive plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(googleDrivePlugin);
    assertNoWildcard(googleDrivePlugin);
  });

  test('every tool classifies to slices the catalog covers, none to the fallback', () => {
    const report = assertCatalogCoverage(googleDrivePlugin);
    assertSlicesOnDataModel(googleDrivePlugin, SAMPLES, { resources: [alice] });
    const named = googleDriveCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect([...report.risksTouched].sort()).toEqual([...named].sort());
    expect(report.risksTouched).toHaveLength(4);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or never reach a URL', async () => {
    const report = await assertIdentifiersRefused(googleDrivePlugin, SAMPLES, {
      resources: [alice],
      context: (fetch, resources) => context(fetch, resources),
      routes: [ANY_DRIVE],
    });
    expect(report.toolsChecked).toBe(googleDrivePlugin.tools.length);
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))]).toContain('fileId');
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(googleDriveCatalog.catalog.service).toBe(SERVICE_ID);
    expect(googleDriveCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${SERVICE_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the service id, once, and every tool has a title', () => {
    expect(toolPrefixFor(SERVICE_ID)).toBe('google_drive__');
    expect(googleDrivePlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.keys(googleDrivePlugin.toolTitles ?? {}).sort()).toEqual(
      Object.values(TOOL).sort(),
    );
  });

  test('no tool shares, deletes or changes permissions; the excluded ones are refused by name', () => {
    const names = googleDrivePlugin.tools.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/share|delete|permission/);
    for (const excluded of Object.keys(googleDrivePlugin.excludedTools ?? {})) {
      expect('denied' in googleDrivePlugin.classify(excluded, {}, [alice]), excluded).toBe(true);
    }
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(googleDrivePlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: googleDrivePlugin.version });
  });

  test('read and write; at Careful and Trusting uploading asks first, reading never does', () => {
    const actions = googleDriveCatalog.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['read', 'write']);
    for (const level of ['careful', 'trusting'] as const) {
      const policy = policyFromMacroActions(googleDrivePlugin, { read: level, write: level });
      const gate = (id: string) => policy.find((l) => l.risk_id === id)?.gate;
      expect(gate('google-drive.file-upload'), level).toBe('approval');
      expect(gate('google-drive.file-read'), level).toBe('auto');
      expect(gate('google-drive.file-list'), level).toBe('auto');
      expect(gate('google-drive.folder-create'), level).toBe('auto');
    }
  });
});

describe('google-drive credential', () => {
  test('signed in at "google" with the drive scope only', () => {
    expect(googleDrivePlugin.credential).toEqual({
      kind: 'oauth2',
      broker: { provider: 'google' },
      scopes: [SCOPES.drive],
    });
  });

  test('the page says Google warns of an unverified app until its review', () => {
    expect(googleDrivePlugin.summary).toMatch(/unverified/);
  });
});
