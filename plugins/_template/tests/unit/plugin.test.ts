/**
 * Mandatory test suite of a plugin : the SDK kit plus classifier cases.
 * No network : `execute` runs against `mockFetch`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  UpstreamProtocolError,
  catalogPathIssues,
  catalogPathNextTo,
  parseSlice,
  serializeSlice,
  toolPrefixFor,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  mockFetch,
  policyFromMacroActions,
  risksTouchedBy,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import { MALFORMED_WIDGET_ID } from '../../src/classify.ts';
import { TEMPLATE_API_BASE } from '../../src/execute.ts';
import { API_KEY_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import defaultExport, {
  classifyTemplate,
  templateCatalog,
  templatePlugin,
} from '../../src/index.ts';

const staging: Resource = {
  provider: PROVIDER_ID,
  ref: 'ws-stg',
  env: 'staging',
  displayName: 'Staging',
};
const prod: Resource = { provider: PROVIDER_ID, ref: 'ws-prd', env: 'prod', displayName: 'Prod' };

describe('template plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(templatePlugin);
    assertNoWildcard(templatePlugin);
  });

  // One table for the catalog coverage and for the identifier proof : the plugin's own
  // `examples` (`src/examples.ts`), each sample with its resources.
  const SAMPLES: ToolSamples = templatePlugin.examples;

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(templatePlugin);
    // What the classifier emits and what the catalog matches are paths of the data model.
    assertSlicesOnDataModel(templatePlugin, SAMPLES, { resources: [staging] });
    expect(catalogPathIssues(templatePlugin)).toEqual([]);
    // A categorized write touches its entry alone ; the fallback is reachable
    // by design and left out of `risksUntouched` (ADR fallback-risk-only-when-uncategorized).
    // Expectations are derived from the catalog : every named risk is touched.
    const risks = templateCatalog.catalog.risks;
    expect(report.risksTouched).toEqual(risks.filter((r) => !r.fallback).map((r) => r.id));
    expect(report.risksTouched).toHaveLength(3);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  // What is executed is what was classified : every string argument of every
  // sample above is fed the hostile identifiers, through `classify` and through
  // `execute`. Keep this test when you copy the template ; your samples feed it.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(templatePlugin, SAMPLES, {
      resources: [staging],
      context: (fetch, resources) => ({
        credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: 'k-123' }, metadata: {} },
        fetch,
        resources,
      }),
    });
    expect(report.toolsChecked).toBe(templatePlugin.tools.length);
    // The workspace and the widget id are segments of the request path.
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getWidget, argument: 'widget_id' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getWidget, argument: 'workspace' });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    // Same computation as src/index.ts, from the test's own location : the
    // path must exist on disk (vitest here ; `next build` and the standalone
    // server are covered by apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts).
    // The expected path is computed from this file too, so a copy of the
    // template needs no edit here whatever its folder is called.
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
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

  test('the plugin is the default export, and its version is the package version', () => {
    // The gateway imports the default export ; telemetry reports `version`,
    // so the two places it is written must never disagree.
    expect(defaultExport).toBe(templatePlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: templatePlugin.version });
  });

  // A mission is composed by ticking macro-actions at a trust level (ADR
  // macro-actions-and-trust-levels-prefill-the-policy) ; `policyFromMacroActions`
  // writes the explicit lines the creation form would.
  test('macro-actions : read runs freely ; at Careful, prod writes ask first', () => {
    const policy = policyFromMacroActions(
      templatePlugin,
      { read: 'careful', write: 'careful' },
      { envs: ['staging', 'prod'] },
    );
    const gates = Object.fromEntries(policy.map((line) => [line.risk_id, line.gate]));
    expect(gates).toMatchObject({
      'template.read-widgets': 'auto',
      'template[staging].widget-write': 'auto',
      'template[prod].widget-write': 'approval',
    });
    expect(Object.keys(gates)).not.toContain(`${PROVIDER_ID}.uncategorized-write`);
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

  test('delete → the verb leaf, which touches the delete risk and the write risk', () => {
    const [slice] = slices(TOOL.deleteWidget, { workspace: 'ws-stg', widget_id: 'w7' });
    expect(slice).toBe(`${PROVIDER_ID}.workspace[ws-stg].widget[w7].delete.W`);
    // A slice may touch several risks ; the mission must accept each of them.
    const touched = risksTouchedBy(parseSlice(slice!), templateCatalog.indexed);
    expect([...touched].sort()).toEqual([
      `${PROVIDER_ID}.widget-delete`,
      `${PROVIDER_ID}.widget-write`,
    ]);
    // An ordinary write does not touch the delete risk.
    const [write] = slices(TOOL.updateWidget, { workspace: 'ws-stg', widget_id: 'w7', name: 'n' });
    expect(risksTouchedBy(parseSlice(write!), templateCatalog.indexed)).toEqual([
      `${PROVIDER_ID}.widget-write`,
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
      denied: MALFORMED_WIDGET_ID,
    });
    const unknown = `${toolPrefixFor(PROVIDER_ID)}delete_all`;
    expect(classifyTemplate(unknown, { workspace: 'ws-stg' }, [staging])).toEqual({
      denied: `unknown tool '${unknown}'`,
    });
  });

  test('an identifier that is not one path segment is refused, never escaped', () => {
    // `..` would survive `encodeURIComponent` and be removed by the URL
    // parser : the request would hit the workspace while the slice named a widget.
    for (const hostile of ['..', '.', 'a/b', 'a%2Fb', 'w 1', '', 'x'.repeat(65), 7, null]) {
      expect(
        classifyTemplate(TOOL.getWidget, { workspace: 'ws-stg', widget_id: hostile }, [staging]),
      ).toEqual({ denied: MALFORMED_WIDGET_ID });
      expect(
        classifyTemplate(
          TOOL.updateWidget,
          { workspace: 'ws-stg', widget_id: hostile, name: 'n' },
          [staging],
        ),
      ).toEqual({ denied: MALFORMED_WIDGET_ID });
    }
    const dotted: Resource = { provider: PROVIDER_ID, ref: '..', displayName: 'Dots' };
    expect(classifyTemplate(TOOL.listWidgets, { workspace: '..' }, [dotted])).toEqual({
      denied: 'workspace: malformed ref',
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

  test('DELETE : a 204 without content becomes a confirmation', async () => {
    const fetch = mockFetch([{ method: 'DELETE', url: /widgets\/w1$/, status: 204 }]);
    const result = await templatePlugin.execute(ctx(fetch), TOOL.deleteWidget, {
      workspace: 'ws-stg',
      widget_id: 'w1',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ deleted: 'w1' }, null, 2) },
    ]);
  });

  test('a provider failure is thrown : 401 as UpstreamAuthError, another status as UpstreamHttpError', async () => {
    const fetch = mockFetch([{ url: /widgets$/, status: 401, body: { error: 'nope' } }]);
    await expect(
      templatePlugin.execute(ctx(fetch), TOOL.listWidgets, { workspace: 'ws-stg' }),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    const broken = mockFetch([{ url: /widgets$/, status: 503, body: { error: 'down' } }]);
    await expect(
      templatePlugin.execute(ctx(broken), TOOL.listWidgets, { workspace: 'ws-stg' }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
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
    // A provider failure (`UpstreamProtocolError`, HTTP 502 for the host), never a plain `Error`.
    await expect(templatePlugin.discoverResources(ctx(fetch))).rejects.toThrow(
      new UpstreamProtocolError('template GET /workspaces: unexpected answer'),
    );
  });

  test('execute resolves the workspace like classify : outside the mission, nothing is sent', async () => {
    const fetch = mockFetch([]);
    // Declined by the executor : an `isError` result, never a throw (a throw is a provider failure).
    const foreign = await templatePlugin.execute(ctx(fetch), TOOL.listWidgets, {
      workspace: 'ws-prd',
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toEqual([
      { type: 'text', text: "workspace 'ws-prd' is not selected in this mission" },
    ]);
    const ambiguous = await templatePlugin.execute(
      ctx(fetch, [staging, prod]),
      TOOL.listWidgets,
      {},
    );
    expect(ambiguous.isError).toBe(true);
    expect(JSON.stringify(ambiguous.content)).toMatch(/the mission touches 2 workspaces/);
    expect(fetch.calls).toHaveLength(0);
  });

  test("execute applies the classifier's identifier check : nothing is sent for an unsafe id", async () => {
    const fetch = mockFetch([]);
    for (const tool of [TOOL.getWidget, TOOL.updateWidget, TOOL.deleteWidget]) {
      const result = await templatePlugin.execute(ctx(fetch), tool, {
        workspace: 'ws-stg',
        widget_id: '..',
        name: 'n',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: MALFORMED_WIDGET_ID }]);
    }
    const unnamed = await templatePlugin.execute(ctx(fetch), TOOL.updateWidget, {
      workspace: 'ws-stg',
      widget_id: 'w1',
    });
    expect(unnamed.isError).toBe(true);
    const unknown = await templatePlugin.execute(
      ctx(fetch),
      `${toolPrefixFor(PROVIDER_ID)}delete_all`,
      { workspace: 'ws-stg' },
    );
    expect(unknown.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test('discoverResources refuses a workspace id no call could name', async () => {
    const fetch = mockFetch([
      { url: `${TEMPLATE_API_BASE}/workspaces`, body: [{ id: 'a/b', name: 'Odd' }] },
    ]);
    await expect(templatePlugin.discoverResources(ctx(fetch))).rejects.toThrow(
      /not a path-safe identifier/,
    );
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
