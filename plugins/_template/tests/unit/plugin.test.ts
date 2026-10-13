/**
 * Mandatory test suite of a plugin : the SDK kit plus classifier cases.
 * No network : `execute` runs against `mockFetch`.
 */
import { describe, expect, test } from 'vitest';

import {
  parseSlice,
  serializeSlice,
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
import { classifyTemplate, templatePlugin } from '../../src/index.ts';

const staging: Resource = {
  provider: 'template',
  ref: 'ws-stg',
  env: 'staging',
  displayName: 'Staging',
};
const prod: Resource = { provider: 'template', ref: 'ws-prd', env: 'prod', displayName: 'Prod' };

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
        template__list_widgets: [{ args: { workspace: 'ws-stg' } }, { args: {} }],
        template__get_widget: [{ args: { workspace: 'ws-prd', widget_id: 'w1' } }],
        template__update_widget: [
          { args: { workspace: 'ws-stg', widget_id: 'w1', name: 'x' } },
          { args: { widget_id: 'w1', name: 'x' }, resources: [staging, prod], expectDenied: true },
        ],
      },
      { resources: [staging] },
    );
    expect(report.risksTouched).toEqual([
      'template.read-widgets',
      'template.widget-write',
      'template.uncategorized-write',
    ]);
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

  test('list → read slice on the named workspace', () => {
    expect(slices('template__list_widgets', { workspace: 'ws-prd' })).toEqual([
      'template.workspace[ws-prd].widget[*].R',
    ]);
  });

  test('update → write slice on the exact widget', () => {
    expect(
      slices('template__update_widget', { workspace: 'ws-stg', widget_id: 'w7', name: 'n' }),
    ).toEqual(['template.workspace[ws-stg].widget[w7].W']);
  });

  test('workspace defaults to the single mission resource', () => {
    expect(slices('template__get_widget', { widget_id: 'w1' })).toEqual([
      'template.workspace[ws-stg].widget[w1].R',
    ]);
  });

  test('refuses an ambiguous or malformed workspace, a malformed id, an unknown tool', () => {
    expect(classifyTemplate('template__list_widgets', {}, [staging, prod])).toEqual({
      denied: 'workspace: argument missing and the mission touches 2 workspaces — name one',
    });
    const none = classifyTemplate('template__list_widgets', {}, []);
    expect('denied' in none ? none.denied : '').toMatch(/touches no workspace/);
    expect(classifyTemplate('template__list_widgets', { workspace: 'a b' }, [staging])).toEqual({
      denied: 'workspace: malformed ref',
    });
    expect(classifyTemplate('template__get_widget', { workspace: 'ws-stg' }, [staging])).toEqual({
      denied: 'widget_id: missing or malformed',
    });
    expect(classifyTemplate('template__delete_all', { workspace: 'ws-stg' }, [staging])).toEqual({
      denied: "unknown tool 'template__delete_all'",
    });
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices('template__update_widget', {
      workspace: 'ws-stg',
      widget_id: 'w7',
      name: 'n',
    })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('executeTemplate with mockFetch', () => {
  const ctx = (fetch: typeof globalThis.fetch): ExecuteContext => ({
    credential: { kind: 'api-key', fields: { api_key: 'k-123' }, metadata: {} },
    appConfig: {},
    fetch,
    resources: [staging],
  });

  test('sends the bearer, returns the provider payload as text', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${TEMPLATE_API_BASE}/workspaces/ws-stg/widgets`,
        body: [{ id: 'w1' }],
      },
    ]);
    const result = await templatePlugin.execute(ctx(fetch), 'template__list_widgets', {
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
    await templatePlugin.execute(ctx(fetch), 'template__update_widget', {
      workspace: 'ws-stg',
      widget_id: 'w1',
      name: 'New',
    });
    expect(fetch.calls[0]!.json).toEqual({ name: 'New' });
  });

  test('401 becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: /widgets$/, status: 401, body: { error: 'nope' } }]);
    await expect(
      templatePlugin.execute(ctx(fetch), 'template__list_widgets', { workspace: 'ws-stg' }),
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
      { provider: 'template', ref: 'ws-1', displayName: 'One' },
    ]);
  });
});
