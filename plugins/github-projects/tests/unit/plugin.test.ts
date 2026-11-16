/**
 * Mandatory test suite of the plugin : the SDK kit, a mission from its
 * macro-actions, the classifier branch by branch, `execute` and discovery
 * against `mockFetch`. No network.
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
  refusalText,
  risksTouchedBy,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import defaultExport, {
  EXAMPLE_OTHER_PROJECT,
  EXAMPLE_PROJECT,
  EXCLUDED_LIST_PROJECTS,
  EXCLUDED_TOOL,
  GITHUB_API_BASE,
  MALFORMED_FIELD_ID,
  MALFORMED_ITEM_ID,
  MALFORMED_PROJECT,
  MALFORMED_VIEW_NUMBER,
  ORGANIZATION_FIELD,
  PROJECT_FIELD,
  SERVICE_ID,
  TOKEN_FIELD,
  TOOL,
  classifyGithubProjects,
  cursorOf,
  githubProjectsCatalog,
  githubProjectsPlugin,
} from '../../src/index.ts';

const project = EXAMPLE_PROJECT;
const other = EXAMPLE_OTHER_PROJECT;
const TOKEN = `github_pat_${'a'.repeat(40)}`;
const BASE = `${GITHUB_API_BASE}/orgs/acme/projectsV2/12`;

const credential = {
  kind: 'api-key' as const,
  fields: { [TOKEN_FIELD]: TOKEN, [ORGANIZATION_FIELD]: 'acme', [PROJECT_FIELD]: '12' },
  metadata: {},
};

const ctx = (
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [project],
): ExecuteContext => ({ credential, fetch, resources });

describe('github-projects plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(githubProjectsPlugin);
    assertNoWildcard(githubProjectsPlugin);
  });

  const SAMPLES: ToolSamples = githubProjectsPlugin.examples;

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(githubProjectsPlugin);
    assertSlicesOnDataModel(githubProjectsPlugin, SAMPLES, { resources: [project] });
    expect(catalogPathIssues(githubProjectsPlugin)).toEqual([]);
    const risks = githubProjectsCatalog.catalog.risks;
    expect([...report.risksTouched].sort()).toEqual(
      risks
        .filter((r) => !r.fallback)
        .map((r) => r.id)
        .sort(),
    );
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(githubProjectsPlugin, SAMPLES, {
      resources: [project],
      context: (fetch, resources) => ({ credential, fetch, resources }),
    });
    expect(report.toolsChecked).toBe(githubProjectsPlugin.tools.length);
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getProjectItem,
      argument: 'item_id',
    });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getProjectField,
      argument: 'field_id',
    });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.listProjectViewItems,
      argument: 'view_number',
    });
  });

  test('the catalog is read next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(githubProjectsCatalog.catalog.service).toBe(SERVICE_ID);
    expect(githubProjectsCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${SERVICE_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the service id; list_projects is excluded', () => {
    const prefix = toolPrefixFor(SERVICE_ID);
    expect(githubProjectsPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(githubProjectsPlugin.excludedTools ?? {})).toEqual([
      EXCLUDED_TOOL.listProjects,
    ]);
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(githubProjectsPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: githubProjectsPlugin.version });
  });

  test('macro-actions : at Careful, reading and tracking run freely, removing asks first', () => {
    const policy = policyFromMacroActions(githubProjectsPlugin, {
      read: 'careful',
      track: 'careful',
      remove: 'careful',
      shape: 'careful',
    });
    const gates = Object.fromEntries(policy.map((line) => [line.risk_id, line.gate]));
    expect(gates).toMatchObject({
      'github-projects.read': 'auto',
      'github-projects.item-add': 'auto',
      'github-projects.item-write': 'auto',
      'github-projects.board-shape': 'auto',
    });
    // Row 4 (irreversible) : asks first, or stays out of the mission.
    expect(gates['github-projects.item-delete'] ?? 'approval').toBe('approval');
    expect(Object.keys(gates)).not.toContain(`${SERVICE_ID}.uncategorized-write`);
  });
});

describe('classifyGithubProjects', () => {
  const slices = (
    tool: string,
    args: Record<string, unknown>,
    resources: readonly Resource[] = [project],
  ) => {
    const out = classifyGithubProjects(tool, args, resources);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };
  const denied = (tool: string, args: Record<string, unknown>, resources = [project]) => {
    const out = classifyGithubProjects(tool, args, resources);
    return 'denied' in out ? out.denied : null;
  };
  const touched = (slice: string) =>
    [...risksTouchedBy(parseSlice(slice), githubProjectsCatalog.indexed)].sort();

  const P = `${SERVICE_ID}.project[acme/12]`;

  test('reads', () => {
    expect(slices(TOOL.getProject, {})).toEqual([`${P}.R`]);
    expect(slices(TOOL.listProjectFields, {})).toEqual([`${P}.field[*].R`]);
    expect(slices(TOOL.getProjectField, { field_id: 4011 })).toEqual([`${P}.field[4011].R`]);
    expect(slices(TOOL.listProjectItems, { q: 'is:open' })).toEqual([`${P}.item[*].R`]);
    expect(slices(TOOL.getProjectItem, { item_id: '981' })).toEqual([`${P}.item[981].R`]);
    expect(slices(TOOL.listProjectViewItems, { view_number: 3 })).toEqual([
      `${P}.view[3].R`,
      `${P}.item[*].R`,
    ]);
    for (const s of [`${P}.R`, `${P}.view[3].R`, `${P}.item[981].R`]) {
      expect(touched(s)).toEqual(['github-projects.read']);
    }
  });

  test('adding an item or a draft touches item-add alone', () => {
    const add = slices(TOOL.addProjectItem, {
      type: 'Issue',
      owner: 'acme',
      repo: 'api',
      number: 42,
    });
    expect(add).toEqual([`${P}.item.W`]);
    expect(slices(TOOL.addProjectDraft, { title: 'x' })).toEqual([`${P}.item.W`]);
    expect(touched(add[0]!)).toEqual(['github-projects.item-add']);
  });

  test('an item update is one slice per field written, each touching item-write alone', () => {
    const out = slices(TOOL.updateProjectItem, {
      item_id: 981,
      fields: [
        { id: 4011, value: 'opt' },
        { id: 4012, value: null },
      ],
    });
    expect(out).toEqual([`${P}.item[981].value[4011].W`, `${P}.item[981].value[4012].W`]);
    expect(touched(out[0]!)).toEqual(['github-projects.item-write']);
  });

  test('a removal touches item-delete alone; fields and views touch board-shape', () => {
    const [del] = slices(TOOL.deleteProjectItem, { item_id: 981 });
    expect(del).toBe(`${P}.item[981].delete.W`);
    expect(touched(del!)).toEqual(['github-projects.item-delete']);
    const [field] = slices(TOOL.createProjectField, { name: 'Size', data_type: 'number' });
    const [view] = slices(TOOL.createProjectView, { name: 'All', layout: 'table' });
    expect([field, view]).toEqual([`${P}.field.W`, `${P}.view.W`]);
    expect(touched(field!)).toEqual(['github-projects.board-shape']);
    expect(touched(view!)).toEqual(['github-projects.board-shape']);
  });

  test('the project : named and selected, or the single one; anything else refused', () => {
    expect(slices(TOOL.getProject, { project: 'acme/7' }, [project, other])).toEqual([
      `${SERVICE_ID}.project[acme/7].R`,
    ]);
    expect(denied(TOOL.getProject, { project: 'acme/7' })).toBe(
      "project 'acme/7' is not selected in this mission",
    );
    expect(denied(TOOL.getProject, {}, [project, other])).toMatch(/holds 2 projects — name one/);
    expect(denied(TOOL.getProject, {}, [])).toMatch(/holds no GitHub project/);
    const foreign: Resource = { service: 'github', ref: 'acme/7', displayName: 'Foreign' };
    expect(denied(TOOL.getProject, { project: 'acme/7' }, [project, foreign])).toMatch(
      /not selected/,
    );
    for (const bad of ['acme', 'acme/0', 'acme/012', '/12', 'ac me/12', '../12', 'acme/12/x', 12]) {
      expect(denied(TOOL.getProject, { project: bad })).toBe(MALFORMED_PROJECT);
    }
  });

  test('ids : positive integers, as numbers or digits; nothing else', () => {
    for (const bad of ['..', '.', '%2e%2e', '0', '-1', '1.5', ' 1', '1e3', '', 0, -3, 1.5, null]) {
      expect(denied(TOOL.getProjectItem, { item_id: bad })).toBe(MALFORMED_ITEM_ID);
      expect(denied(TOOL.deleteProjectItem, { item_id: bad })).toBe(MALFORMED_ITEM_ID);
      expect(denied(TOOL.getProjectField, { field_id: bad })).toBe(MALFORMED_FIELD_ID);
      expect(denied(TOOL.listProjectViewItems, { view_number: bad })).toBe(MALFORMED_VIEW_NUMBER);
    }
    expect(
      denied(TOOL.updateProjectItem, { item_id: 1, fields: [{ id: '..', value: 'x' }] }),
    ).toMatch(/^fields:/);
  });

  test('arguments that do not read are refused', () => {
    expect(denied(TOOL.updateProjectItem, { item_id: 1, fields: [] })).toMatch(/^fields:/);
    expect(
      denied(TOOL.updateProjectItem, {
        item_id: 1,
        fields: [
          { id: 2, value: 'a' },
          { id: 2, value: 'b' },
        ],
      }),
    ).toMatch(/each field once/);
    expect(denied(TOOL.updateProjectItem, { item_id: 1, fields: [{ id: 2 }] })).toMatch(/^fields:/);
    expect(denied(TOOL.updateProjectItem, { item_id: 1, fields: [{ id: 2, value: {} }] })).toMatch(
      /^fields:/,
    );
    expect(denied(TOOL.addProjectItem, { type: 'Discussion', content_id: 1 })).toMatch(/^type:/);
    expect(denied(TOOL.addProjectItem, { type: 'Issue', content_id: 1, owner: 'a' })).toMatch(
      /not both/,
    );
    expect(
      denied(TOOL.addProjectItem, { type: 'Issue', owner: 'a', repo: '..', number: 1 }),
    ).toMatch(/owner \+ repo \+ number/);
    expect(denied(TOOL.addProjectDraft, { title: '' })).toMatch(/^title:/);
    expect(denied(TOOL.addProjectDraft, { title: 'a\nb' })).toMatch(/^title:/);
    expect(denied(TOOL.listProjectItems, { per_page: 101 })).toMatch(/^per_page:/);
    expect(denied(TOOL.listProjectItems, { after: 'a', before: 'b' })).toMatch(/not both/);
    expect(denied(TOOL.createProjectField, { name: 'x', data_type: 'single_select' })).toMatch(
      /^single_select_options:/,
    );
    expect(
      denied(TOOL.createProjectField, {
        name: 'x',
        data_type: 'iteration',
        iteration_configuration: { start_date: '2026-02-30', duration: 14 },
      }),
    ).toMatch(/^iteration_configuration:/);
    expect(
      denied(TOOL.createProjectField, {
        name: 'x',
        data_type: 'text',
        single_select_options: [{ name: 'a', color: 'RED' }],
      }),
    ).toMatch(/only for a single_select/);
    expect(denied(TOOL.createProjectView, { name: 'x', layout: 'gantt' })).toMatch(/^layout:/);
    expect(
      denied(TOOL.createProjectView, { name: 'x', layout: 'roadmap', visible_fields: [1] }),
    ).toMatch(/not for a roadmap/);
    expect(
      denied(TOOL.createProjectView, { name: 'x', layout: 'board', group_by: [1, 2] }),
    ).toMatch(/exactly one field id/);
  });

  test('an unknown tool and the excluded list_projects are refused', () => {
    const unknown = `${toolPrefixFor(SERVICE_ID)}delete_project`;
    expect(denied(unknown, {})).toBe(`unknown tool '${unknown}'`);
    expect(denied(EXCLUDED_TOOL.listProjects, {})).toBe(EXCLUDED_LIST_PROJECTS);
  });

  test('emitted slices parse back', () => {
    for (const s of slices(TOOL.updateProjectItem, { item_id: 9, fields: [{ id: 3, value: 1 }] })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('executeGithubProjects with mockFetch', () => {
  test('a read sends the token and the API version to the project path', async () => {
    const fetch = mockFetch([{ method: 'GET', url: BASE, body: { number: 12, title: 'Roadmap' } }]);
    const result = await githubProjectsPlugin.execute(ctx(fetch), TOOL.getProject, {});
    expect(result.isError).toBeUndefined();
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetch.calls[0]!.headers['x-github-api-version']).toBe('2026-03-10');
  });

  test('a list carries q, fields and the cursor, and answers the cursors of the Link header', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => u.startsWith(`${BASE}/items?`),
        body: [{ id: 981 }],
        headers: {
          link: `<${BASE}/items?after=TkVYVA&per_page=2>; rel="next", <${BASE}/items?before=UFJFVg&per_page=2>; rel="prev"`,
        },
      },
    ]);
    const result = await githubProjectsPlugin.execute(ctx(fetch), TOOL.listProjectItems, {
      q: 'status:Todo',
      fields: [4011, '4012'],
      per_page: 2,
      after: 'Y3Vy',
    });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/orgs/acme/projectsV2/12/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'status:Todo',
      fields: '4011,4012',
      per_page: '2',
      after: 'Y3Vy',
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      items: [{ id: 981 }],
      next: 'TkVYVA',
      previous: 'UFJFVg',
    });
  });

  test('writes : the bodies are built field by field from the checked call', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${BASE}/items`, status: 201, body: { id: 1 } },
      { method: 'POST', url: `${BASE}/drafts`, status: 201, body: { id: 2 } },
      { method: 'PATCH', url: `${BASE}/items/981`, body: { id: 981 } },
      { method: 'POST', url: `${BASE}/fields`, status: 201, body: { id: 5 } },
      { method: 'POST', url: `${BASE}/views`, status: 201, body: { id: 6 } },
    ]);
    const run = (tool: string, args: Record<string, unknown>) =>
      githubProjectsPlugin.execute(ctx(fetch), tool, args);
    await run(TOOL.addProjectItem, {
      type: 'Issue',
      owner: 'acme',
      repo: 'api',
      number: '42',
      undeclared: 'never sent',
    });
    await run(TOOL.addProjectDraft, { title: 'Spike', body: 'Line 1\nLine 2' });
    await run(TOOL.updateProjectItem, {
      item_id: '981',
      fields: [{ id: 4011, value: 'opt', x: 1 }],
    });
    await run(TOOL.createProjectField, {
      name: 'Sprint',
      data_type: 'iteration',
      iteration_configuration: { start_date: '2026-11-16', duration: 14 },
    });
    await run(TOOL.createProjectView, {
      name: 'Board',
      layout: 'board',
      sort_by: [[4011, 'asc']],
      vertical_group_by: ['4011'],
    });
    expect(fetch.calls.map((c) => c.json)).toEqual([
      { type: 'Issue', owner: 'acme', repo: 'api', number: 42 },
      { title: 'Spike', body: 'Line 1\nLine 2' },
      { fields: [{ id: 4011, value: 'opt' }] },
      {
        name: 'Sprint',
        data_type: 'iteration',
        iteration_configuration: { start_date: '2026-11-16', duration: 14, iterations: [] },
      },
      { name: 'Board', layout: 'board', sort_by: [[4011, 'asc']], vertical_group_by: [4011] },
    ]);
  });

  test('DELETE : a 204 becomes a confirmation', async () => {
    const fetch = mockFetch([{ method: 'DELETE', url: `${BASE}/items/981`, status: 204 }]);
    const result = await githubProjectsPlugin.execute(ctx(fetch), TOOL.deleteProjectItem, {
      item_id: 981,
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      removed: 981,
      project: 'acme/12',
    });
  });

  test('service failures are thrown, typed', async () => {
    const denied = mockFetch([{ url: BASE, status: 403, body: { message: 'Forbidden' } }]);
    await expect(
      githubProjectsPlugin.execute(ctx(denied), TOOL.getProject, {}),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError' });
    const broken = mockFetch([{ url: BASE, status: 503, body: {} }]);
    await expect(
      githubProjectsPlugin.execute(ctx(broken), TOOL.getProject, {}),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });

  test('execute reads the call like classify : declined calls send nothing', async () => {
    const fetch = mockFetch([]);
    const run = (tool: string, args: Record<string, unknown>, resources = [project]) =>
      refusalText(githubProjectsPlugin.execute(ctx(fetch, resources), tool, args));
    expect(await run(TOOL.getProject, { project: 'acme/7' })).toBe(
      "project 'acme/7' is not selected in this mission",
    );
    expect(await run(TOOL.getProject, {}, [project, other])).toMatch(/name one/);
    for (const hostile of ['..', '%2e%2e', '%2f', 'a/../b', '1?x=1#y']) {
      expect(await run(TOOL.getProjectItem, { item_id: hostile })).toBe(MALFORMED_ITEM_ID);
      expect(await run(TOOL.deleteProjectItem, { item_id: hostile })).toBe(MALFORMED_ITEM_ID);
      expect(await run(TOOL.getProjectField, { field_id: hostile })).toBe(MALFORMED_FIELD_ID);
      expect(await run(TOOL.getProject, { project: hostile })).toBe(MALFORMED_PROJECT);
    }
    expect(await run(EXCLUDED_TOOL.listProjects, {})).toBe(EXCLUDED_LIST_PROJECTS);
    expect(fetch.calls).toHaveLength(0);
  });

  test('cursorOf reads the cursor of one relation, or nothing', () => {
    expect(cursorOf(null, 'next', 'after')).toBeNull();
    expect(cursorOf('<https://x/y?after=A>; rel="prev"', 'next', 'after')).toBeNull();
    expect(cursorOf('<not a url>; rel="next"', 'next', 'after')).toBeNull();
  });
});

describe('discoverResources', () => {
  test("the account's one project, in GitHub's spelling", async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: BASE,
        body: { number: 12, title: 'Roadmap', owner: { login: 'Acme' } },
      },
    ]);
    expect(await githubProjectsPlugin.discoverResources(ctx(fetch))).toEqual([
      { service: SERVICE_ID, ref: 'Acme/12', displayName: 'Roadmap' },
    ]);
  });

  test('an answer without owner, number or title is the service failure', async () => {
    const fetch = mockFetch([{ method: 'GET', url: BASE, body: { title: 'Roadmap' } }]);
    await expect(githubProjectsPlugin.discoverResources(ctx(fetch))).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
  });
});
