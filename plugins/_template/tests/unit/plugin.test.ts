/**
 * Mandatory test suite of a plugin : the SDK kit plus classifier cases.
 * No network : `execute` runs against `mockFetch`.
 */
import { existsSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  catalogPathNextTo,
  parseSlice,
  serializeSlice,
  toolPrefixFor,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';

import { TEMPLATE_API_BASE } from '../../src/execute.ts';
import { API_KEY_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import { classifyTemplate, templateCatalog, templatePlugin } from '../../src/index.ts';

const staging: Resource = {
  provider: PROVIDER_ID,
  ref: 'ws-stg',
  env: 'staging',
  displayName: 'Staging',
};
const prod: Resource = { provider: PROVIDER_ID, ref: 'ws-prd', env: 'prod', displayName: 'Prod' };

describe('template plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(templatePlugin);
    assertPresetsValid(templatePlugin);
    assertNoWildcard(templatePlugin);
  });

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(
      templatePlugin,
      {
        [TOOL.listWidgets]: [{ args: { workspace: 'ws-stg' } }, { args: {} }],
        [TOOL.getWidget]: [
          { args: { workspace: 'ws-prd', widget_id: 'w1' }, resources: [staging, prod] },
          // A workspace the mission does not hold is refused by the classifier.
          { args: { workspace: 'ws-prd', widget_id: 'w1' }, expectDenied: true },
        ],
        [TOOL.updateWidget]: [
          { args: { workspace: 'ws-stg', widget_id: 'w1', name: 'x' } },
          { args: { widget_id: 'w1', name: 'x' }, resources: [staging, prod], expectDenied: true },
        ],
      },
      { resources: [staging] },
    );
    // A categorized write touches its entry alone ; the fallback is reachable
    // by design and left out of `risksUntouched` (ADR fallback-risk-only-when-uncategorized).
    // Expectations are derived from the catalog : every named risk is touched.
    const risks = templateCatalog.catalog.risks;
    expect(report.risksTouched).toEqual(risks.filter((r) => !r.fallback).map((r) => r.id));
    expect(report.risksTouched).toHaveLength(2);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    // Same computation as src/index.ts, from the test's own location : the
    // path must exist on disk (vitest here ; `next build` and the standalone
    // server are covered by apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts).
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path.endsWith('/plugins/_template/src/risk-catalog.yaml')).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(templateCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(templatePlugin.id).toBe(PROVIDER_ID);
    expect(templateCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(templatePlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(templatePlugin.credential).toMatchObject({
      kind: 'api-key',
      fields: [{ name: API_KEY_FIELD, secret: true }],
    });
  });
});

describe('classifyTemplate', () => {
  const slices = (
    tool: string,
    args: Record<string, unknown>,
    resources: readonly Resource[] = [staging],
  ) => {
    const out = classifyTemplate(tool, args, resources);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };

  test('list → read slice on the named workspace, one of the mission resources', () => {
    expect(slices(TOOL.listWidgets, { workspace: 'ws-prd' }, [staging, prod])).toEqual([
      `${PROVIDER_ID}.workspace[ws-prd].widget[*].R`,
    ]);
  });

  test('a named workspace outside the mission resources is refused', () => {
    // The mission holds `ws-stg` only : naming `ws-prd` must not classify
    // (and must not silently fall back to the single resource).
    expect(classifyTemplate(TOOL.listWidgets, { workspace: 'ws-prd' }, [staging])).toEqual({
      denied: "workspace 'ws-prd' is not selected in this mission",
    });
    expect(
      classifyTemplate(TOOL.updateWidget, { workspace: 'ws-prd', widget_id: 'w1' }, [staging]),
    ).toEqual({ denied: "workspace 'ws-prd' is not selected in this mission" });
    // A resource of another provider carrying the same ref does not count.
    const foreign: Resource = { provider: 'other', ref: 'ws-prd', displayName: 'Foreign' };
    expect(classifyTemplate(TOOL.listWidgets, { workspace: 'ws-prd' }, [staging, foreign])).toEqual(
      { denied: "workspace 'ws-prd' is not selected in this mission" },
    );
  });

  test('update → write slice on the exact widget', () => {
    expect(slices(TOOL.updateWidget, { workspace: 'ws-stg', widget_id: 'w7', name: 'n' })).toEqual([
      `${PROVIDER_ID}.workspace[ws-stg].widget[w7].W`,
    ]);
  });

  test('workspace defaults to the single mission resource', () => {
    expect(slices(TOOL.getWidget, { widget_id: 'w1' })).toEqual([
      `${PROVIDER_ID}.workspace[ws-stg].widget[w1].R`,
    ]);
  });

  test('refuses an ambiguous or malformed workspace, a malformed id, an unknown tool', () => {
    expect(classifyTemplate(TOOL.listWidgets, {}, [staging, prod])).toEqual({
      denied: 'workspace: argument missing and the mission touches 2 workspaces — name one',
    });
    const none = classifyTemplate(TOOL.listWidgets, {}, []);
    expect('denied' in none ? none.denied : '').toMatch(/touches no workspace/);
    expect(classifyTemplate(TOOL.listWidgets, { workspace: 'a b' }, [staging])).toEqual({
      denied: 'workspace: malformed ref',
    });
    expect(classifyTemplate(TOOL.listWidgets, { workspace: 42 }, [staging])).toEqual({
      denied: 'workspace: malformed ref',
    });
    expect(classifyTemplate(TOOL.getWidget, { workspace: 'ws-stg' }, [staging])).toEqual({
      denied: 'widget_id: missing or malformed',
    });
    const unknown = `${toolPrefixFor(PROVIDER_ID)}delete_all`;
    expect(classifyTemplate(unknown, { workspace: 'ws-stg' }, [staging])).toEqual({
      denied: `unknown tool '${unknown}'`,
    });
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices(TOOL.updateWidget, {
      workspace: 'ws-stg',
      widget_id: 'w7',
      name: 'n',
    })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('executeTemplate with mockFetch', () => {
  const ctx = (
    fetch: typeof globalThis.fetch,
    resources: readonly Resource[] = [staging],
  ): ExecuteContext => ({
    credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: 'k-123' }, metadata: {} },
    appConfig: {},
    fetch,
    resources,
  });

  test('sends the bearer, returns the provider payload as text', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${TEMPLATE_API_BASE}/workspaces/ws-stg/widgets`,
        body: [{ id: 'w1' }],
      },
    ]);
    const result = await templatePlugin.execute(ctx(fetch), TOOL.listWidgets, {
      workspace: 'ws-stg',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual([{ id: 'w1' }]);
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer k-123');
  });

  test('PATCH carries the JSON body', async () => {
    const fetch = mockFetch([
      { method: 'PATCH', url: /widgets\/w1$/, respond: (c) => ({ renamed: c.json }) },
    ]);
    await templatePlugin.execute(ctx(fetch), TOOL.updateWidget, {
      workspace: 'ws-stg',
      widget_id: 'w1',
      name: 'New',
    });
    expect(fetch.calls[0]!.json).toEqual({ name: 'New' });
  });

  test('401 becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: /widgets$/, status: 401, body: { error: 'nope' } }]);
    await expect(
      templatePlugin.execute(ctx(fetch), TOOL.listWidgets, { workspace: 'ws-stg' }),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });

  test('discoverResources maps workspaces to resources', async () => {
    const fetch = mockFetch([
      { url: `${TEMPLATE_API_BASE}/workspaces`, body: [{ id: 'ws-1', name: 'One' }] },
    ]);
    expect(await templatePlugin.discoverResources(ctx(fetch))).toEqual([
      { provider: PROVIDER_ID, ref: 'ws-1', displayName: 'One' },
    ]);
  });

  test('discoverResources refuses a payload that is not a workspace list', async () => {
    const fetch = mockFetch([
      { url: `${TEMPLATE_API_BASE}/workspaces`, body: { data: [{ id: 'ws-1' }] } },
    ]);
    await expect(templatePlugin.discoverResources(ctx(fetch))).rejects.toThrow(
      /unexpected workspace list/,
    );
  });

  test('execute resolves the workspace like classify : outside the mission, nothing is sent', async () => {
    const fetch = mockFetch([]);
    await expect(
      templatePlugin.execute(ctx(fetch), TOOL.listWidgets, { workspace: 'ws-prd' }),
    ).rejects.toThrow("workspace 'ws-prd' is not selected in this mission");
    await expect(
      templatePlugin.execute(ctx(fetch, [staging, prod]), TOOL.listWidgets, {}),
    ).rejects.toThrow(/the mission touches 2 workspaces/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('execute falls back to the single mission workspace', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${TEMPLATE_API_BASE}/workspaces/ws-stg/widgets`, body: [] },
    ]);
    await templatePlugin.execute(ctx(fetch), TOOL.listWidgets, {});
    expect(fetch.calls).toHaveLength(1);
  });

  test('a credential without the declared secret field is refused before any request', async () => {
    const fetch = mockFetch([]);
    const noKey: ExecuteContext = {
      ...ctx(fetch),
      credential: { kind: 'api-key', fields: {}, metadata: {} },
    };
    await expect(templatePlugin.execute(noKey, TOOL.listWidgets, {})).rejects.toThrow(
      new RegExp(`'${API_KEY_FIELD}'`),
    );
    expect(fetch.calls).toHaveLength(0);
  });
});
