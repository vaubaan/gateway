/**
 * Mandatory suite of the `notion` plugin : the SDK kit (well-formed, no
 * wildcard, macro-actions, catalog coverage, the identifier proof), the identity and the
 * version. No network : `execute` runs against `mockFetch`.
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
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import { API_TOKEN_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { notionCatalog, notionPlugin } from '../../src/index.ts';
import { SAMPLES } from './samples.ts';
import { DISCUSSION, TOKEN, echoWrites, pageRoot, world } from './fixtures.ts';

describe('notion plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(notionPlugin);
    assertNoWildcard(notionPlugin);
  });

  test('every tool classifies to slices the catalog covers, none by the fallback', () => {
    const report = assertCatalogCoverage(notionPlugin, SAMPLES, { resources: [pageRoot] });
    assertSlicesOnDataModel(notionPlugin, SAMPLES, { resources: [pageRoot] });
    const named = notionCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(report.risksTouched).toEqual(named);
    expect(report.risksTouched).toHaveLength(14);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(notionPlugin, SAMPLES, {
      resources: [pageRoot],
      routes: [
        ...world(),
        {
          method: 'GET',
          url: /\/comments\?/,
          body: { results: [{ id: DISCUSSION, discussion_id: DISCUSSION }], has_more: false },
        },
        { method: 'POST', url: /\/search$/, body: { results: [], has_more: false } },
        {
          method: 'GET',
          url: /\/children\?/,
          body: { object: 'list', results: [], has_more: false },
        },
        echoWrites,
      ],
      context: (fetch, resources) => ({
        credential: { kind: 'api-key', fields: { [API_TOKEN_FIELD]: TOKEN }, metadata: {} },
        fetch,
        resources,
      }),
    });
    expect(report.toolsChecked).toBe(notionPlugin.tools.length);
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getPage, argument: 'page_id' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.deleteBlock, argument: 'block_id' });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.queryDataSource,
      argument: 'data_source_id',
    });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(notionCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(notionCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and each has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(notionPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(notionPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
  });

  test('the plugin is the default export', () => {
    expect(defaultExport).toBe(notionPlugin);
  });

  test('macro-actions : read, comment, write, reorganize ; explicit risks, the fallback in none', () => {
    const { risks, macro_actions: actions } = notionCatalog.catalog;
    expect(actions.map((a) => a.id)).toEqual(['read', 'comment', 'write', 'reorganize']);
    const fallback = risks.find((r) => r.fallback)?.id;
    for (const entry of actions.flatMap((a) => a.entries)) {
      expect(entry.risk_id).not.toMatch(/[*?[\]]/);
      expect(entry.risk_id).not.toBe(fallback);
    }
  });

  test('at Confiant the destructive operations ask first ; everything else runs freely', () => {
    const policy = policyFromMacroActions(notionPlugin, {
      read: 'confiant',
      comment: 'confiant',
      write: 'confiant',
      reorganize: 'confiant',
    });
    const gated = policy.filter((l) => l.gate === 'approval').map((l) => l.risk_id);
    expect(gated.sort()).toEqual([
      'notion.block-delete',
      'notion.block-update',
      'notion.page-trash',
      'notion.root-trash',
    ]);
    // Deleting and trashing live in reorganize alone.
    const others = notionCatalog.catalog.macro_actions
      .filter((a) => a.id !== 'reorganize')
      .flatMap((a) => a.entries.map((e) => e.risk_id));
    expect(others).not.toContain('notion.page-trash');
    expect(others).not.toContain('notion.block-delete');
  });
});
