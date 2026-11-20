/**
 * The team pin : every call the plugin makes to Vercel acts for the team of
 * the account's credential (`team_id`), and that team never comes from the
 * tool arguments.
 *
 * The suite is table-driven over **every declared tool**, so a tool added
 * later is covered or fails here. For each tool it proves :
 *   - with no `teamId` argument, each request carries the credential's team ;
 *   - a `teamId` argument that is not exactly the credential's — another
 *     string, or any non-string — is refused before any network call ;
 *   - the credential's own value is accepted and changes nothing.
 *
 * Four rewrapped tools cannot carry a team (their upstream schema is closed
 * and has no `teamId`) ; they are listed in `TEAMLESS_UPSTREAM_TOOLS` with the
 * reason, and the list is checked against the schemas.
 */
import { describe, expect, test } from 'vitest';
import { mockFetch, type MockFetch, type RecordedCall } from '@vaubaan/plugin-sdk/testing';

import { UNBOUND_TOOLS } from '../../src/classify.ts';
import { TEAMLESS_UPSTREAM_TOOLS } from '../../src/execute.ts';
import { vercelPlugin, VERCEL_API_BASE } from '../../src/index.ts';
import { REST_READ_TOOLS } from '../../src/rest-reads.ts';
import { isCustomTool } from '../../src/tools.ts';
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';

import { app, ctx, forwardedArgs, isMcpCall, mcpRoute, site, TEAM } from './fixtures.ts';

/** One valid call per declared tool, without `teamId`. */
const SAMPLES: Readonly<Record<string, Record<string, unknown>>> = {
  vercel__search_vercel_documentation: { topic: 'routing' },
  vercel__deploy_to_vercel: {},
  vercel__list_projects: {},
  vercel__get_project: {},
  vercel__list_deployments: {},
  vercel__get_deployment: { idOrUrl: 'dpl_1' },
  vercel__get_deployment_build_logs: { idOrUrl: 'dpl_1' },
  vercel__get_runtime_logs: { deploymentId: 'dpl_1' },
  vercel__get_access_to_vercel_url: { url: 'https://app-git-main.vercel.app/' },
  vercel__web_fetch_vercel_url: { url: 'https://app-git-main.vercel.app/' },
  vercel__list_teams: {},
  vercel__check_domain_availability_and_price: { names: ['example.com'] },
  vercel__list_toolbar_threads: {},
  vercel__get_toolbar_thread: { threadId: 'thr_1' },
  vercel__change_toolbar_thread_resolve_status: { threadId: 'thr_1', resolved: true },
  vercel__reply_to_toolbar_thread: { threadId: 'thr_1', markdown: 'x' },
  vercel__edit_toolbar_message: { threadId: 'thr_1', messageId: 'msg_1', markdown: 'x' },
  vercel__add_toolbar_reaction: { threadId: 'thr_1', messageId: 'msg_1', emoji: '+1' },
  vercel__update_project_settings: { framework: 'nextjs' },
  vercel__disconnect_git: {},
  vercel__upsert_env_var: { key: 'K', value: 'v', target: ['preview'] },
  vercel__list_env_vars: {},
  vercel__delete_env_var: { id: 'env_1' },
  vercel__list_project_domains: {},
  vercel__add_project_domain: { name: 'www.example.com' },
  vercel__verify_project_domain: { domain: 'www.example.com' },
  vercel__remove_project_domain: { domain: 'www.example.com' },
  vercel__get_firewall_config: {},
  vercel__toggle_firewall: { enabled: true },
  vercel__upsert_firewall_rule: {
    name: 'r',
    active: true,
    conditionGroup: [],
    action: { type: 'deny' },
  },
  vercel__remove_firewall_rule: { ruleId: 'rule_1' },
  vercel__manage_ip_blocking: { operation: 'insert', ip: '10.0.0.1' },
};

const TOOLS = vercelPlugin.tools.map((t) => t.name);

/** Vercel answering anything : the deployment lookup, the REST API, the MCP server. */
function vercel(): MockFetch {
  return mockFetch([
    {
      method: 'GET',
      url: /\/v13\/deployments\//,
      body: { id: 'dpl_1', projectId: 'prj_abc', ownerId: TEAM },
    },
    mcpRoute,
    { url: (u) => u.startsWith(`${VERCEL_API_BASE}/`), body: {} },
  ]);
}

/** The team a recorded request acts for, or `null` when it names none. */
function teamOf(call: RecordedCall): unknown {
  if (isMcpCall(call)) return forwardedArgs(call).teamId ?? null;
  const url = new URL(call.url);
  const inPath = /^\/v2\/teams\/([^/]+)$/.exec(url.pathname);
  return inPath ? decodeURIComponent(inPath[1]!) : url.searchParams.get('teamId');
}

/** Answered from the mission's resources : no request, so no team to carry. */
const NO_REQUEST_TOOLS: ReadonlySet<string> = new Set(['vercel__list_projects']);

function expectPinned(tool: string, calls: readonly RecordedCall[]): void {
  if (UNBOUND_TOOLS.has(tool) || NO_REQUEST_TOOLS.has(tool)) {
    expect(calls, `${tool} makes no call at all`).toHaveLength(0);
    return;
  }
  expect(calls.length, `${tool} made no call`).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.headers.authorization, tool).toBe('Bearer vcp_secret');
    if (isMcpCall(call) && tool in TEAMLESS_UPSTREAM_TOOLS) {
      expect(teamOf(call), `${tool} has a closed schema without teamId`).toBeNull();
    } else {
      expect(teamOf(call), `${tool} → ${call.method} ${call.url}`).toBe(TEAM);
    }
  }
}

describe('team pin — every declared tool has a sample', () => {
  test('the sample table is exactly the declared tool list', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...TOOLS].sort());
  });
});

describe('team pin — every request carries the team of the credential', () => {
  test.each(TOOLS)('%s without a teamId argument', async (tool) => {
    const fetch = vercel();
    await vercelPlugin.execute(ctx(fetch), tool, SAMPLES[tool]!);
    expectPinned(tool, fetch.calls);
  });

  test.each(TOOLS)('%s with the teamId of the credential as argument', async (tool) => {
    const fetch = vercel();
    await vercelPlugin.execute(ctx(fetch), tool, { ...SAMPLES[tool]!, teamId: TEAM });
    expectPinned(tool, fetch.calls);
  });

  test('discovery reads the pinned team and lists its projects only', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: /\/v2\/teams\//, body: { id: TEAM } },
      { method: 'GET', url: /\/v10\/projects\?/, body: { projects: [], pagination: {} } },
    ]);
    await vercelPlugin.discoverResources(ctx(fetch));
    expect(fetch.calls).toHaveLength(2);
    for (const call of fetch.calls) expect(teamOf(call)).toBe(TEAM);
  });
});

describe('team pin — a team id never comes from the tool arguments', () => {
  const NOT_THE_TEAM: readonly unknown[] = [
    'team_other',
    'TEAM_ABC',
    ` ${TEAM}`,
    '',
    null,
    42,
    true,
    [TEAM],
    ['team_other'],
    { id: 'team_other' },
  ];

  test.each(TOOLS)(
    '%s refuses every teamId that is not exactly the credential team',
    async (tool) => {
      for (const teamId of NOT_THE_TEAM) {
        const fetch = vercel();
        const result = await vercelPlugin.execute(ctx(fetch), tool, { ...SAMPLES[tool]!, teamId });
        const label = `${tool} teamId=${JSON.stringify(teamId)}`;
        expect(result.isError, label).toBe(true);
        expect(fetch.calls, label).toHaveLength(0);
      }
    },
  );
});

describe('team pin — the tools that cannot carry a team are reviewed one by one', () => {
  test('the reviewed list is exactly the rewrapped tools whose closed schema has no teamId', () => {
    const closedWithoutTeam = vercelPlugin.tools
      .filter((t) => !isCustomTool(t.name))
      .filter((t) => !('teamId' in (t.inputSchema?.properties ?? {})))
      .filter(
        (t) => (t.inputSchema as Readonly<Record<string, unknown>>).additionalProperties === false,
      )
      .map((t) => t.name);
    expect(Object.keys(TEAMLESS_UPSTREAM_TOOLS).sort()).toEqual(closedWithoutTeam.sort());
    expect(Object.keys(TEAMLESS_UPSTREAM_TOOLS).sort()).toEqual([
      'vercel__check_domain_availability_and_price',
      'vercel__get_access_to_vercel_url',
      'vercel__search_vercel_documentation',
      'vercel__web_fetch_vercel_url',
    ]);
    for (const reason of Object.values(TEAMLESS_UPSTREAM_TOOLS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test('the two URL tools reach the MCP server only after a lookup under the pinned team', async () => {
    for (const tool of ['vercel__get_access_to_vercel_url', 'vercel__web_fetch_vercel_url']) {
      const fetch = vercel();
      await vercelPlugin.execute(ctx(fetch), tool, SAMPLES[tool]!);
      expect(fetch.calls.map((c) => c.url)).toEqual([
        `${VERCEL_API_BASE}/v13/deployments/app-git-main.vercel.app?teamId=${TEAM}`,
        'https://mcp.vercel.com/',
      ]);
    }
  });

  test('the two argument-less tools (open schema) do carry the team, and deploy the project too', async () => {
    const teams = vercel();
    await vercelPlugin.execute(ctx(teams), 'vercel__list_teams', {});
    expect(forwardedArgs(teams.calls[0]!)).toEqual({ teamId: TEAM });

    const deploy = vercel();
    await vercelPlugin.execute(ctx(deploy), 'vercel__deploy_to_vercel', {});
    expect(forwardedArgs(deploy.calls[0]!)).toEqual({ teamId: TEAM, projectId: 'prj_abc' });
  });

  test('a custom REST tool takes the team from the credential, in the query', async () => {
    const fetch = vercel();
    await vercelPlugin.execute(ctx(fetch), 'vercel__list_env_vars', { teamId: TEAM });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=${TEAM}`,
    ]);
  });
});

/**
 * A token scoped to one project (`project_id`, ADR
 * one-place-to-authorize-services-token-first, amendment 2026-11-11) : the
 * REST API is sent no team (Vercel infers it from the token), Vercel's MCP
 * server — which rejects such a token — is never called (the essential reads
 * go to the REST API, the other rewrapped tools are refused), every `teamId`
 * argument is refused, and so is another project.
 */
describe('project pin — an account scoped to one project', () => {
  const owned: Resource = { ...app, metadata: { team_id: TEAM } };
  const projectCtx = (
    fetch: typeof globalThis.fetch,
    resources: readonly Resource[] = [owned],
  ): ExecuteContext => ({
    credential: {
      kind: 'api-key',
      fields: { token: 'vcp_secret', project_id: 'prj_abc' },
      metadata: {},
    },
    fetch,
    resources,
  });

  test.each(TOOLS)(
    '%s names no team and never reaches the MCP server (it rejects a project token)',
    async (tool) => {
      const fetch = vercel();
      const result = await vercelPlugin.execute(projectCtx(fetch), tool, SAMPLES[tool]!);
      expect(fetch.calls.filter(isMcpCall), tool).toHaveLength(0);
      if (UNBOUND_TOOLS.has(tool)) {
        expect(fetch.calls).toHaveLength(0);
        return;
      }
      if (!isCustomTool(tool) && !REST_READ_TOOLS.has(tool)) {
        expect(result.isError, tool).toBe(true);
        expect(JSON.stringify(result.content)).toContain(
          "Vercel's MCP server does not accept a token scoped to one project",
        );
        expect(fetch.calls, `${tool} is refused before any request`).toHaveLength(0);
        return;
      }
      if (NO_REQUEST_TOOLS.has(tool)) {
        expect(result.isError, tool).toBeUndefined();
        expect(fetch.calls, tool).toHaveLength(0);
        return;
      }
      expect(fetch.calls.length, `${tool} made no call`).toBeGreaterThan(0);
      for (const call of fetch.calls) {
        expect(call.headers.authorization, tool).toBe('Bearer vcp_secret');
        expect(teamOf(call), `${tool} → ${call.method} ${call.url}`).toBeNull();
      }
    },
  );

  test.each(TOOLS)('%s refuses every teamId argument, the right team included', async (tool) => {
    for (const teamId of [TEAM, 'team_other', '']) {
      const fetch = vercel();
      const result = await vercelPlugin.execute(projectCtx(fetch), tool, {
        ...SAMPLES[tool]!,
        teamId,
      });
      expect(result.isError, `${tool} teamId=${teamId}`).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('another project, even one the mission holds, is refused before any call', async () => {
    const fetch = vercel();
    const result = await vercelPlugin.execute(
      projectCtx(fetch, [owned, site]),
      'vercel__list_env_vars',
      { projectId: 'prj_site' },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not the project this account is scoped to');
    expect(fetch.calls).toHaveLength(0);
  });

  test('a deployment is looked up without teamId, bound to the project, and that lookup answers', async () => {
    const fetch = vercel();
    await vercelPlugin.execute(projectCtx(fetch), 'vercel__get_deployment', { idOrUrl: 'dpl_1' });
    expect(fetch.calls.map((c) => c.url)).toEqual([`${VERCEL_API_BASE}/v13/deployments/dpl_1`]);
  });

  test('no request depends on the team discovery read', async () => {
    for (const tool of ['vercel__get_project', 'vercel__list_env_vars']) {
      const fetch = vercel();
      const result = await vercelPlugin.execute(projectCtx(fetch, [app]), tool, {});
      expect(result.isError, tool).toBeUndefined();
      expect(fetch.calls).toHaveLength(1);
    }
  });
});
