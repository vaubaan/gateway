/**
 * Binding of the second identifier : a tool addressed by a deployment id, a
 * deployment URL or a toolbar thread is classified on the mission's project,
 * so `execute` must prove the target belongs to that project before the
 * upstream call — or refuse the tool when it cannot.
 *
 * Every lookup goes to the REST API with the account's pinned team. No
 * test reaches the network : an unmatched request rejects.
 */
import { describe, expect, test } from 'vitest';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyVercel, UNBOUND_TOOLS } from '../../src/classify.ts';
import { vercelPlugin, VERCEL_API_BASE } from '../../src/index.ts';
import { isCustomTool } from '../../src/tools.ts';
import {
  app,
  ctx,
  deploymentRoute,
  forwardedArgs,
  isMcpCall,
  mcpRoute,
  site,
  TEAM,
  text,
} from './fixtures.ts';

const OWN = { id: 'dpl_own', projectId: 'prj_abc', ownerId: TEAM };
const FOREIGN = { id: 'dpl_foreign', projectId: 'prj_victim', ownerId: TEAM };

/** One row per deployment-addressed tool : the arguments, and the key the lookup must use. */
const DEPLOYMENT_ADDRESSED: ReadonlyArray<{
  tool: string;
  args: Record<string, unknown>;
  key: string;
}> = [
  { tool: 'vercel__get_deployment', args: { idOrUrl: 'dpl_x' }, key: 'dpl_x' },
  { tool: 'vercel__get_deployment_build_logs', args: { idOrUrl: 'dpl_x' }, key: 'dpl_x' },
  { tool: 'vercel__get_runtime_logs', args: { deploymentId: 'dpl_x' }, key: 'dpl_x' },
  {
    tool: 'vercel__get_access_to_vercel_url',
    args: { url: 'https://other-project.vercel.app/admin?x=1' },
    key: 'other-project.vercel.app',
  },
  {
    tool: 'vercel__web_fetch_vercel_url',
    args: { url: 'https://other-project.vercel.app/admin?x=1' },
    key: 'other-project.vercel.app',
  },
];

describe('executeVercel — a deployment-addressed tool runs only on a deployment of the mission project', () => {
  test.each(DEPLOYMENT_ADDRESSED)(
    '$tool : a deployment of another project is refused, nothing reaches the MCP server',
    async ({ tool, args, key }) => {
      const fetch = mockFetch([deploymentRoute(key, FOREIGN), mcpRoute]);
      const result = await vercelPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/does not belong to vercel project 'prj_abc'/);
      expect(fetch.calls).toHaveLength(1);
      expect(fetch.calls[0]!.url).toBe(`${VERCEL_API_BASE}/v13/deployments/${key}?teamId=${TEAM}`);
      expect(fetch.calls.filter(isMcpCall)).toHaveLength(0);
    },
  );

  test.each(DEPLOYMENT_ADDRESSED)(
    '$tool : a deployment the pinned team cannot see (404) is refused',
    async ({ tool, args, key }) => {
      const fetch = mockFetch([deploymentRoute(key, null), mcpRoute]);
      const result = await vercelPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/could not be verified/);
      expect(fetch.calls.filter(isMcpCall)).toHaveLength(0);
    },
  );

  test.each(DEPLOYMENT_ADDRESSED)(
    '$tool : a deployment of the mission project is forwarded',
    async ({ tool, args, key }) => {
      const fetch = mockFetch([deploymentRoute(key, OWN), mcpRoute]);
      const result = await vercelPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBeUndefined();
      expect(fetch.calls).toHaveLength(2);
      expect(isMcpCall(fetch.calls[1]!)).toBe(true);
    },
  );

  test('the id-addressed tools forward the verified deployment id, not the caller spelling', async () => {
    const fetch = mockFetch([deploymentRoute('app-git-main.vercel.app', OWN), mcpRoute]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__get_deployment', {
      idOrUrl: 'https://app-git-main.vercel.app/some/path',
    });
    expect(forwardedArgs(fetch.calls[1]!)).toEqual({ idOrUrl: 'dpl_own', teamId: TEAM });

    const logs = mockFetch([deploymentRoute('dpl_x', OWN), mcpRoute]);
    await vercelPlugin.execute(ctx(logs), 'vercel__get_runtime_logs', { deploymentId: 'dpl_x' });
    expect(forwardedArgs(logs.calls[1]!)).toEqual({
      deploymentId: 'dpl_own',
      projectId: 'prj_abc',
      teamId: TEAM,
    });
  });

  test('the URL tools forward the normalised URL whose host was verified', async () => {
    const fetch = mockFetch([deploymentRoute('app-git-main.vercel.app', OWN), mcpRoute]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__get_access_to_vercel_url', {
      url: 'https://APP-git-main.vercel.app\\@evil.vercel.app',
    });
    expect(forwardedArgs(fetch.calls[1]!)).toEqual({
      url: 'https://app-git-main.vercel.app/@evil.vercel.app',
    });
  });

  test('a reduced view (no projectId), a missing id or a deployment owned by another team is refused', async () => {
    for (const answer of [
      { id: 'dpl_x' },
      { projectId: 'prj_abc' },
      { id: 'dpl_x', projectId: 'prj_abc', ownerId: 'team_other' },
      { id: 42, projectId: ['prj_abc'] },
    ]) {
      const fetch = mockFetch([deploymentRoute('dpl_x', answer), mcpRoute]);
      const result = await vercelPlugin.execute(ctx(fetch), 'vercel__get_deployment', {
        idOrUrl: 'dpl_x',
      });
      expect(result.isError, JSON.stringify(answer)).toBe(true);
      expect(fetch.calls.filter(isMcpCall), JSON.stringify(answer)).toHaveLength(0);
    }
  });

  test('a 403 on the lookup is a refusal, not an expired account ; a 401 still is', async () => {
    const lookup = /\/v13\/deployments\/dpl_x\?/;
    const forbidden = mockFetch([{ method: 'GET', url: lookup, status: 403, body: {} }, mcpRoute]);
    const result = await vercelPlugin.execute(ctx(forbidden), 'vercel__get_deployment', {
      idOrUrl: 'dpl_x',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/could not be verified/);
    expect(forbidden.calls.filter(isMcpCall)).toHaveLength(0);

    const unauthorized = mockFetch([{ method: 'GET', url: lookup, status: 401, body: {} }]);
    await expect(
      vercelPlugin.execute(ctx(unauthorized), 'vercel__get_deployment', { idOrUrl: 'dpl_x' }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 401 });
  });

  test('a lookup the service fails (5xx) is an upstream failure, thrown ; nothing is forwarded', async () => {
    const lookup = /\/v13\/deployments\/dpl_x\?/;
    const broken = mockFetch([{ method: 'GET', url: lookup, status: 503, body: {} }, mcpRoute]);
    await expect(
      vercelPlugin.execute(ctx(broken), 'vercel__get_deployment', { idOrUrl: 'dpl_x' }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    expect(broken.calls.filter(isMcpCall)).toHaveLength(0);
  });

  test.each([
    ['vercel__get_deployment', {}],
    ['vercel__get_deployment', { idOrUrl: ['dpl_x'] }],
    ['vercel__get_deployment', { idOrUrl: '' }],
    ['vercel__get_deployment', { idOrUrl: 'dpl_x/../../v9/projects' }],
    ['vercel__get_deployment', { idOrUrl: 'dpl_x?teamId=team_other' }],
    ['vercel__get_deployment_build_logs', { idOrUrl: 42 }],
    ['vercel__get_runtime_logs', { deploymentId: { id: 'dpl_x' } }],
    ['vercel__get_runtime_logs', { deploymentId: null }],
    ['vercel__get_access_to_vercel_url', {}],
    ['vercel__get_access_to_vercel_url', { url: 'app.vercel.app' }],
    ['vercel__get_access_to_vercel_url', { url: 'ftp://app.vercel.app/' }],
    ['vercel__get_access_to_vercel_url', { url: 'https://user:pw@app.vercel.app/' }],
    ['vercel__web_fetch_vercel_url', { url: ['https://app.vercel.app/'] }],
    ['vercel__web_fetch_vercel_url', { url: 'not a url' }],
  ] as const)(
    '%s %j : an unreadable deployment argument is refused before any network call',
    async (tool, args) => {
      const fetch = mockFetch([]);
      const result = await vercelPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    },
  );

  test('get_runtime_logs without deploymentId needs no lookup : the project is forced', async () => {
    const fetch = mockFetch([mcpRoute]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__get_runtime_logs', {});
    expect(fetch.calls).toHaveLength(1);
    expect(forwardedArgs(fetch.calls[0]!)).toEqual({ projectId: 'prj_abc', teamId: TEAM });
  });

  test('with several mission projects the named one is the one the deployment must belong to', async () => {
    const wrong = mockFetch([deploymentRoute('dpl_x', OWN), mcpRoute]);
    const refused = await vercelPlugin.execute(ctx(wrong, [app, site]), 'vercel__get_deployment', {
      projectId: 'prj_site',
      idOrUrl: 'dpl_x',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/does not belong to vercel project 'prj_site'/);
    expect(wrong.calls.filter(isMcpCall)).toHaveLength(0);

    const right = mockFetch([deploymentRoute('dpl_x', OWN), mcpRoute]);
    await vercelPlugin.execute(ctx(right, [app, site]), 'vercel__get_deployment', {
      projectId: 'prj_abc',
      idOrUrl: 'dpl_x',
    });
    // `projectId` selected the project ; the upstream schema has no such argument.
    expect(forwardedArgs(right.calls[1]!)).toEqual({ idOrUrl: 'dpl_own', teamId: TEAM });

    const none = mockFetch([]);
    const ambiguous = await vercelPlugin.execute(ctx(none, [app, site]), 'vercel__get_deployment', {
      idOrUrl: 'dpl_x',
    });
    expect(ambiguous.isError).toBe(true);
    expect(none.calls).toHaveLength(0);
  });

  test('every declared rewrapped tool that takes a deployment argument is bound (schema-driven)', async () => {
    const deploymentArgs = ['idOrUrl', 'deploymentId', 'url'] as const;
    const addressed = vercelPlugin.tools.filter(
      (t) =>
        !isCustomTool(t.name) && deploymentArgs.some((a) => a in (t.inputSchema?.properties ?? {})),
    );
    expect(addressed.map((t) => t.name).sort()).toEqual(
      DEPLOYMENT_ADDRESSED.map((r) => r.tool).sort(),
    );
    for (const tool of addressed) {
      const arg = deploymentArgs.find((a) => a in (tool.inputSchema?.properties ?? {}))!;
      const value = arg === 'url' ? 'https://victim.vercel.app/' : 'dpl_victim';
      const fetch = mockFetch([
        { method: 'GET', url: /\/v13\/deployments\//, body: FOREIGN },
        mcpRoute,
      ]);
      const result = await vercelPlugin.execute(ctx(fetch), tool.name, { [arg]: value });
      expect(result.isError, tool.name).toBe(true);
      expect(fetch.calls.filter(isMcpCall), tool.name).toHaveLength(0);
    }
  });
});

describe('thread-addressed tools cannot be bound to a project : refused', () => {
  const THREAD_TOOLS = [
    'vercel__get_toolbar_thread',
    'vercel__change_toolbar_thread_resolve_status',
    'vercel__reply_to_toolbar_thread',
    'vercel__edit_toolbar_message',
    'vercel__add_toolbar_reaction',
  ];

  test('the refused set is every declared tool that takes a threadId', () => {
    const declared = vercelPlugin.tools
      .filter((t) => 'threadId' in (t.inputSchema?.properties ?? {}))
      .map((t) => t.name);
    expect(declared.sort()).toEqual([...THREAD_TOOLS].sort());
    expect([...UNBOUND_TOOLS].sort()).toEqual([...THREAD_TOOLS].sort());
  });

  test.each(THREAD_TOOLS)('%s is denied by the classifier', (tool) => {
    const out = classifyVercel(tool, { projectId: 'prj_abc', threadId: 'thr_1' }, [app]);
    expect('denied' in out ? out.denied : null).toMatch(
      /cannot be bound to a project of this mission/,
    );
  });

  test.each(THREAD_TOOLS)('%s is refused by execute before any network call', async (tool) => {
    const fetch = mockFetch([]);
    const result = await vercelPlugin.execute(ctx(fetch), tool, {
      threadId: 'thr_1',
      messageId: 'msg_1',
      markdown: 'x',
      emoji: '+1',
      resolved: true,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/cannot be bound to a project of this mission/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('list_toolbar_threads stays available, always filtered on the mission project', async () => {
    const fetch = mockFetch([mcpRoute]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__list_toolbar_threads', { status: 'open' });
    expect(forwardedArgs(fetch.calls[0]!)).toEqual({
      status: 'open',
      projectId: 'prj_abc',
      teamId: TEAM,
    });
  });
});

describe('executeVercel — the project is the one the classifier resolved', () => {
  test('a projectId outside the mission, a non-string one or an unknown tool is refused with no call', async () => {
    for (const [tool, args] of [
      ['vercel__get_project', { projectId: 'prj_victim' }],
      ['vercel__list_env_vars', { projectId: ['prj_abc'] }],
      ['vercel__update_project_settings', { projectId: 'prj_victim', framework: 'nextjs' }],
      ['vercel__list_projects', { projectId: 'prj_victim' }],
      ['vercel__drop_everything', {}],
    ] as const) {
      const fetch = mockFetch([]);
      const result = await vercelPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError, tool).toBe(true);
      expect(fetch.calls, tool).toHaveLength(0);
    }
  });
});
