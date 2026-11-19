/**
 * An account scoped to one project (`project_id`) : Vercel's MCP server
 * rejects its token (401 `invalid_token`), so `get_project`,
 * `list_deployments`, `get_deployment` and `get_deployment_build_logs` are
 * served by the REST API without `teamId`, and every other rewrapped tool is
 * refused before any request. Team mode is unchanged.
 *
 * No test reaches the network : an unmatched request rejects.
 */
import { describe, expect, test } from 'vitest';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';

import { vercelPlugin, VERCEL_API_BASE } from '../../src/index.ts';
import {
  BUILD_LOGS_MAX_LIMIT,
  LIST_DEPLOYMENTS_LIMIT,
  PROJECT_REST_TOOLS,
} from '../../src/project-mode.ts';
import { REDACTED_VALUE } from '../../src/redact.ts';
import { isCustomTool } from '../../src/tools.ts';
import { app, ctx, deploymentRoute, isMcpCall, mcpRoute, site, text } from './fixtures.ts';

const owned: Resource = { ...app, metadata: { team_id: 'team_abc' } };

function projectCtx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [owned],
): ExecuteContext {
  return {
    credential: {
      kind: 'api-key',
      fields: { token: 'vcp_secret', project_id: 'prj_abc' },
      metadata: {},
    },
    fetch,
    resources,
  };
}

const OWN = { id: 'dpl_own', projectId: 'prj_abc', ownerId: 'team_abc', url: 'app.vercel.app' };
const lookup = (key: string, body: Record<string, unknown> | null, status = 200) => ({
  method: 'GET',
  url: `${VERCEL_API_BASE}/v13/deployments/${key}`,
  status: body === null ? 404 : status,
  body: body ?? { error: { code: 'not_found', message: 'Deployment not found' } },
});

const json = (result: { content: readonly unknown[] }): unknown => JSON.parse(text(result));

describe('project mode — the essential reads go to the REST API', () => {
  test('the four REST-served tools are exactly these', () => {
    expect([...PROJECT_REST_TOOLS].sort()).toEqual([
      'vercel__get_deployment',
      'vercel__get_deployment_build_logs',
      'vercel__get_project',
      'vercel__list_deployments',
    ]);
  });

  test('get_project → GET /v9/projects/{id} without teamId, redacted by allow-list', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc`,
        body: {
          id: 'prj_abc',
          name: 'app',
          framework: 'nextjs',
          env: [{ id: 'e1', key: 'DATABASE_URL', type: 'plain', value: 'postgres://secret' }],
          link: { type: 'github', repo: 'app', deployHooks: [{ id: 'h1', url: 'https://hook' }] },
          somethingNew: 'value',
        },
      },
    ]);
    const result = await vercelPlugin.execute(projectCtx(fetch), 'vercel__get_project', {});
    expect(result.isError).toBeUndefined();
    expect(fetch.calls.map((c) => c.url)).toEqual([`${VERCEL_API_BASE}/v9/projects/prj_abc`]);
    expect(json(result)).toMatchObject({
      name: 'app',
      env: [{ key: 'DATABASE_URL', value: REDACTED_VALUE }],
      link: { deployHooks: [{ id: 'h1', url: REDACTED_VALUE }] },
      somethingNew: REDACTED_VALUE,
    });
    expect(text(result)).not.toContain('postgres://secret');
    expect(text(result)).not.toContain('https://hook');
  });

  test('list_deployments → GET /v6/deployments for the pinned project, bounded, since/until passed', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: /\/v6\/deployments\?/,
        body: { deployments: [{ uid: 'dpl_1' }], pagination: { count: 1, next: null } },
      },
    ]);
    const result = await vercelPlugin.execute(projectCtx(fetch), 'vercel__list_deployments', {
      since: 1700000000000,
      until: 1800000000000.7,
    });
    expect(result.isError).toBeUndefined();
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/v6/deployments');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: 'prj_abc',
      limit: String(LIST_DEPLOYMENTS_LIMIT),
      since: '1700000000000',
      until: '1800000000000',
    });
    expect(json(result)).toEqual({
      deployments: [{ uid: 'dpl_1' }],
      pagination: { count: 1, next: null },
    });
  });

  test.each([{ since: 'yesterday' }, { until: -1 }, { since: Number.NaN }])(
    'list_deployments %j : an unreadable timestamp is refused before any request',
    async (args) => {
      const fetch = mockFetch([]);
      const result = await vercelPlugin.execute(
        projectCtx(fetch),
        'vercel__list_deployments',
        args,
      );
      expect(result.isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    },
  );

  test('get_deployment answers the binding lookup itself : one request, no teamId', async () => {
    const fetch = mockFetch([lookup('dpl_x', OWN)]);
    const result = await vercelPlugin.execute(projectCtx(fetch), 'vercel__get_deployment', {
      idOrUrl: 'dpl_x',
    });
    expect(result.isError).toBeUndefined();
    expect(fetch.calls).toHaveLength(1);
    expect(json(result)).toEqual(OWN);
  });

  test('get_deployment_build_logs → the newest events, oldest first, bounded', async () => {
    const fetch = mockFetch([
      lookup('app.vercel.app', OWN),
      {
        method: 'GET',
        url: /\/v3\/deployments\/dpl_own\/events\?/,
        body: [
          { created: 3, type: 'stdout', text: 'Deployment completed', info: { name: 'bld' } },
          { created: 2, type: 'stderr', text: 'warning' },
          { created: 1, type: 'command', payload: { text: 'npm run build' } },
        ],
      },
    ]);
    const result = await vercelPlugin.execute(
      projectCtx(fetch),
      'vercel__get_deployment_build_logs',
      { idOrUrl: 'https://app.vercel.app/x', limit: 5000 },
    );
    expect(result.isError).toBeUndefined();
    const url = new URL(fetch.calls[1]!.url);
    expect(url.pathname).toBe('/v3/deployments/dpl_own/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      follow: '0',
      direction: 'backward',
      limit: String(BUILD_LOGS_MAX_LIMIT),
    });
    expect(json(result)).toEqual({
      deploymentId: 'dpl_own',
      lines: [
        { created: 1, type: 'command', text: 'npm run build' },
        { created: 2, type: 'stderr', text: 'warning' },
        { created: 3, type: 'stdout', text: 'Deployment completed' },
      ],
    });
  });

  test('get_deployment_build_logs : the default limit is 100, a non-positive limit is refused', async () => {
    const fetch = mockFetch([
      lookup('dpl_x', OWN),
      { method: 'GET', url: /\/v3\/deployments\/dpl_own\/events\?/, body: [] },
    ]);
    await vercelPlugin.execute(projectCtx(fetch), 'vercel__get_deployment_build_logs', {
      idOrUrl: 'dpl_x',
    });
    expect(new URL(fetch.calls[1]!.url).searchParams.get('limit')).toBe('100');

    const refused = mockFetch([lookup('dpl_x', OWN)]);
    const result = await vercelPlugin.execute(
      projectCtx(refused),
      'vercel__get_deployment_build_logs',
      { idOrUrl: 'dpl_x', limit: 0 },
    );
    expect(result.isError).toBe(true);
    expect(refused.calls.every((c) => !c.url.includes('/events'))).toBe(true);
  });

  test.each(['vercel__get_deployment', 'vercel__get_deployment_build_logs'])(
    '%s : a deployment of another project, or one the token cannot see, is refused',
    async (tool) => {
      const foreign = mockFetch([lookup('dpl_x', { ...OWN, projectId: 'prj_victim' })]);
      const r1 = await vercelPlugin.execute(projectCtx(foreign), tool, { idOrUrl: 'dpl_x' });
      expect(r1.isError).toBe(true);
      expect(text(r1)).toMatch(/does not belong to vercel project 'prj_abc'/);
      expect(foreign.calls).toHaveLength(1);

      const hidden = mockFetch([lookup('dpl_x', null)]);
      const r2 = await vercelPlugin.execute(projectCtx(hidden), tool, { idOrUrl: 'dpl_x' });
      expect(r2.isError).toBe(true);
      expect(text(r2)).toMatch(/could not be verified/);
      expect(hidden.calls).toHaveLength(1);
    },
  );

  test('another project, even one the mission holds, is refused before any request', async () => {
    const fetch = mockFetch([]);
    const result = await vercelPlugin.execute(
      projectCtx(fetch, [owned, site]),
      'vercel__list_deployments',
      { projectId: 'prj_site' },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not the project this account is scoped to');
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('project mode — every other rewrapped tool is refused before any request', () => {
  const refused = vercelPlugin.tools
    .map((t) => t.name)
    .filter((name) => !isCustomTool(name) && !PROJECT_REST_TOOLS.has(name));

  test.each(refused)('%s', async (tool) => {
    const fetch = mockFetch([]);
    const result = await vercelPlugin.execute(projectCtx(fetch), tool, {});
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test('the message says why, and which account runs the tool', async () => {
    const fetch = mockFetch([]);
    const result = await vercelPlugin.execute(projectCtx(fetch), 'vercel__get_runtime_logs', {});
    expect(text(result)).toContain(
      "Vercel's MCP server does not accept a token scoped to one project",
    );
    expect(text(result)).toContain('A team account (token Scope = the team, All Projects)');
  });
});

describe('team mode is unchanged — the same reads go to the MCP server', () => {
  test.each([
    ['vercel__get_project', {}],
    ['vercel__list_deployments', {}],
    ['vercel__get_runtime_logs', {}],
  ] as const)('%s is forwarded to the MCP server', async (tool, args) => {
    const fetch = mockFetch([mcpRoute]);
    await vercelPlugin.execute(ctx(fetch), tool, args);
    expect(fetch.calls).toHaveLength(1);
    expect(isMcpCall(fetch.calls[0]!)).toBe(true);
  });

  test('get_deployment is looked up, then forwarded', async () => {
    const fetch = mockFetch([deploymentRoute('dpl_x', OWN), mcpRoute]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__get_deployment', { idOrUrl: 'dpl_x' });
    expect(fetch.calls.map(isMcpCall)).toEqual([false, true]);
  });
});
