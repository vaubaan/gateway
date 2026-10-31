/**
 * Mandatory test suite of the `context7` plugin : the SDK kit, the frozen
 * upstream surface, the version and the catalog path. No network.
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
  policyFromMacroActions,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import upstream from '../../src/upstream-tools.json' with { type: 'json' };
import defaultExport, {
  API_KEY_FIELD,
  PROVIDER_ID,
  TOOL,
  context7Catalog,
  context7Plugin,
} from '../../src/index.ts';
import { DOCS_RESULT, ctx, index, mcpAnswers } from './support.ts';

/** One table for the catalog coverage and for the identifier proof (handbook). */
const SAMPLES: ToolSamples = {
  [TOOL.resolveLibraryId]: [
    { args: { libraryName: 'Next.js', query: 'app router middleware' } },
    // A mission without a Context7 resource.
    {
      args: { libraryName: 'Next.js', query: 'app router middleware' },
      resources: [],
      expectDenied: true,
    },
  ],
  [TOOL.queryDocs]: [
    { args: { libraryId: '/vercel/next.js', query: 'middleware matcher' } },
    {
      args: {
        libraryId: '/vercel/next.js@v14.3.0',
        query: 'middleware matcher',
        language: 'TypeScript',
      },
    },
    // An upstream alias for `libraryId` : undeclared, refused.
    { args: { libraryName: '/evil/lib', query: 'middleware matcher' }, expectDenied: true },
    { args: { libraryId: '/a/../b', query: 'middleware matcher' }, expectDenied: true },
  ],
};

describe('context7 plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(context7Plugin);
    assertNoWildcard(context7Plugin);
  });

  test('every tool classifies to slices the catalog covers, none on the fallback', () => {
    const report = assertCatalogCoverage(context7Plugin, SAMPLES, { resources: [index] });
    const named = context7Catalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(named).toEqual([`${PROVIDER_ID}.query-docs`]);
    expect(report.risksTouched).toEqual(named);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or never reach a URL', async () => {
    const report = await assertIdentifiersRefused(context7Plugin, SAMPLES, {
      resources: [index],
      routes: [mcpAnswers(DOCS_RESULT)],
      context: (fetch, resources) => ctx(fetch, resources),
      pathIdentifiers: {
        none: 'one JSON-RPC POST to a constant URL; every argument travels in the body',
      },
    });
    expect(report.toolsChecked).toBe(context7Plugin.tools.length);
    // `libraryId` is refused on every hostile value ; the free texts are sent in the body.
    expect(report.refusedByClassify).toBeGreaterThan(0);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(context7Catalog.catalog.provider).toBe(PROVIDER_ID);
    expect(context7Plugin.id).toBe(PROVIDER_ID);
    expect(context7Catalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(context7Plugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: context7Plugin.version });
  });

  test('the credential is one secret API key, checked before it is stored', () => {
    expect(context7Plugin.credential).toMatchObject({
      kind: 'api-key',
      fields: [{ name: API_KEY_FIELD, secret: true, required: true }],
    });
    const spec = context7Plugin.credential;
    if (spec.kind !== 'api-key') throw new Error('expected an api-key credential');
    expect(typeof spec.verify).toBe('function');
    const pattern = new RegExp(spec.fields[0]!.pattern!);
    expect(pattern.test('ctx7sk-test0123456789abcdefghijklmnopqrstu')).toBe(true);
    for (const bad of [
      'sk-test0123456789abcdef',
      'ctx7sk-short',
      'ctx7sk-has space 0123456789',
      '',
    ]) {
      expect(pattern.test(bad), bad).toBe(false);
    }
  });

  test('one macro-action with the drafted base budget, the fallback in none', () => {
    expect(context7Catalog.catalog.macro_actions).toEqual([
      expect.objectContaining({
        id: 'ask',
        entries: [
          {
            risk_id: `${PROVIDER_ID}.query-docs`,
            quota: 300,
            rate_limit: { max: 20, window_seconds: 60 },
          },
        ],
      }),
    ]);
  });

  // The question leaves for a third party and cannot be recalled : the
  // vector is irreversible, so no trust level runs a query freely.
  test('a query is left out at Prudent and asks first at the other trust levels', () => {
    expect(policyFromMacroActions(context7Plugin, { ask: 'prudent' })).toEqual([]);
    expect(policyFromMacroActions(context7Plugin, { ask: 'confiant' })).toEqual([
      {
        risk_id: `${PROVIDER_ID}.query-docs`,
        quota: 900,
        rate_limit: { max: 60, window_seconds: 60 },
        gate: 'approval',
      },
    ]);
  });

  test('no environment anywhere', () => {
    expect('envOf' in context7Plugin).toBe(false);
    for (const plane of context7Plugin.dataModel.planes) {
      expect(plane.entities.some((e) => e.envScopable)).toBe(false);
    }
    for (const risk of context7Catalog.catalog.risks) {
      expect(risk.acceptable_in_envs).toBeUndefined();
    }
  });
});

describe('context7 tools — the frozen upstream surface', () => {
  test('exactly the two tools of tools/list, prefixed, with their schemas unchanged', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(upstream.map((t) => t.name)).toEqual(['resolve-library-id', 'query-docs']);
    expect(context7Plugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    for (const [i, tool] of context7Plugin.tools.entries()) {
      const source = upstream[i]!;
      expect(tool.name).toBe(`${prefix}${source.name}`);
      expect(tool.description).toBe(source.description);
      expect(tool.inputSchema.properties).toEqual(source.inputSchema.properties);
      expect(tool.inputSchema.required).toEqual(source.inputSchema.required);
    }
  });

  test('the schemas checked live on 2026-10-16', () => {
    const [resolve, query] = context7Plugin.tools;
    expect(Object.keys(resolve!.inputSchema.properties ?? {}).sort()).toEqual([
      'libraryName',
      'query',
    ]);
    expect(resolve!.inputSchema.required).toEqual(['query', 'libraryName']);
    expect(Object.keys(query!.inputSchema.properties ?? {}).sort()).toEqual([
      'language',
      'libraryId',
      'query',
    ]);
    expect(query!.inputSchema.required).toEqual(['libraryId', 'query']);
  });

  test('no upstream alias is declared, so none can be sent', () => {
    const aliases = ['userQuery', 'question', 'context7CompatibleLibraryID', 'libraryID'];
    for (const tool of context7Plugin.tools) {
      const declared = Object.keys(tool.inputSchema.properties ?? {});
      expect(declared.filter((name) => aliases.includes(name))).toEqual([]);
    }
    const query = context7Plugin.tools.find((t) => t.name === TOOL.queryDocs)!;
    expect(Object.keys(query.inputSchema.properties ?? {})).not.toContain('libraryName');
  });

  test('every tool has a title', () => {
    for (const tool of context7Plugin.tools) {
      expect(context7Plugin.toolTitles?.[tool.name], tool.name).toBeTruthy();
    }
  });
});
