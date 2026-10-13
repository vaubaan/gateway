/**
 * Mandatory suite of the `vercel` plugin : the SDK kit, the v5 classifier
 * conventions (project resolution against mission resources), the credential
 * spec, `execute` and `discoverResources` against `mockFetch`.
 *
 * The v4 classifier cases live unchanged in `risk-classifier.test.ts` (31) ;
 * the legacy adapter in `adapter.test.ts` (23) ; both go with P1.6.
 * No test ever reaches the network : an unmatched request rejects.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialKindMismatch,
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
  type RecordedCall,
} from '@vaubaan/plugin-sdk/testing';

import {
  classifyVercel,
  DISCOVERY_MAX_PAGES,
  vercelAuth,
  vercelCredential,
  vercelEnvOf,
  vercelPlugin,
  VERCEL_API_BASE,
  VERCEL_MCP_URL,
} from '../../src/index.ts';

const app: Resource = { provider: 'vercel', ref: 'prj_abc', displayName: 'app' };
const site: Resource = { provider: 'vercel', ref: 'prj_site', displayName: 'site' };
const foreign: Resource = { provider: 'github', ref: 'acme/app', displayName: 'acme/app' };

const credential = {
  kind: 'api-key' as const,
  fields: { token: 'vcp_secret', team_id: 'team_abc' },
  metadata: {},
};

function ctx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [app],
): ExecuteContext {
  return { credential, appConfig: {}, fetch, resources };
}

/** One SSE frame carrying the JSON-RPC answer to the recorded request. */
function sseFrame(call: RecordedCall, result: unknown): string {
  const id = (call.json as { id: number }).id;
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

function sseError(call: RecordedCall, code: number, message: string): string {
  const id = (call.json as { id: number }).id;
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural kit
// ─────────────────────────────────────────────────────────────────────────────

describe('vercel plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(vercelPlugin);
    assertPresetsValid(vercelPlugin);
    assertNoWildcard(vercelPlugin);
  });

  test('ships read-only, developer and operator presets ; developer never touches production configuration', () => {
    const ids = vercelPlugin.catalog.presets.map((p) => p.id);
    expect(ids).toEqual(['read-only', 'developer', 'operator']);
    const developer = vercelPlugin.catalog.presets.find((p) => p.id === 'developer')!;
    const risks = developer.entries.map((e) => e.risk_id);
    for (const forbidden of [
      'vercel[prod].deploy',
      'vercel[prod].env-var-write',
      'vercel.env-var-fan-out',
      'vercel.project-settings-write',
      'vercel.domain-write',
      'vercel.firewall-write',
      'vercel.firewall-rule-write',
      'vercel.ip-rule-write',
      'vercel.read-env-var-plaintext',
      'vercel.uncategorized-write',
    ]) {
      expect(risks, `developer must not include ${forbidden}`).not.toContain(forbidden);
    }
    expect(risks).toContain('vercel[preview].deploy');
    expect(risks).toContain('vercel[preview].env-var-write');
    const operator = vercelPlugin.catalog.presets.find((p) => p.id === 'operator')!;
    const gated = operator.entries.filter((e) => e.gate === 'approval').map((e) => e.risk_id);
    expect(gated).toEqual(
      expect.arrayContaining([
        'vercel[prod].deploy',
        'vercel[prod].env-var-write',
        'vercel.env-var-fan-out',
        'vercel.project-settings-write',
        'vercel.domain-write',
        'vercel.firewall-write',
      ]),
    );
  });

  test('every tool classifies to slices the catalog covers', () => {
    const p = { projectId: 'prj_abc' };
    const report = assertCatalogCoverage(
      vercelPlugin,
      {
        vercel__search_vercel_documentation: [{ args: { topic: 'routing' } }],
        vercel__list_teams: [{ args: {} }],
        vercel__list_projects: [{ args: { teamId: 'team_abc' } }],
        vercel__check_domain_availability_and_price: [{ args: { names: ['example.com'] } }],
        vercel__get_project: [{ args: { ...p, teamId: 'team_abc' } }, { args: {} }],
        vercel__list_project_domains: [{ args: p }],
        vercel__list_deployments: [{ args: p }],
        vercel__get_deployment: [{ args: { ...p, idOrUrl: 'dpl_1' } }],
        vercel__get_deployment_build_logs: [{ args: { ...p, idOrUrl: 'dpl_1' } }],
        vercel__get_runtime_logs: [{ args: { ...p, deploymentId: 'dpl_1' } }],
        vercel__web_fetch_vercel_url: [{ args: { url: 'https://app-git-main.vercel.app/' } }],
        vercel__list_toolbar_threads: [{ args: p }],
        vercel__get_toolbar_thread: [{ args: { ...p, threadId: 'thr_1' } }],
        vercel__list_env_vars: [{ args: p }, { args: { ...p, decrypt: true } }],
        vercel__deploy_to_vercel: [
          { args: { ...p, target: 'preview' } },
          { args: { ...p, target: 'production' } },
          { args: {} },
        ],
        vercel__get_access_to_vercel_url: [{ args: { url: 'https://app-git-main.vercel.app/' } }],
        vercel__upsert_env_var: [
          { args: { ...p, key: 'K', value: 'v', target: ['preview'] } },
          { args: { ...p, key: 'K', value: 'v' } },
        ],
        vercel__delete_env_var: [{ args: { ...p, id: 'env_1' } }],
        vercel__update_project_settings: [{ args: { ...p, framework: 'nextjs' } }],
        vercel__add_project_domain: [{ args: { ...p, name: 'www.example.com' } }],
        vercel__verify_project_domain: [{ args: { ...p, domain: 'www.example.com' } }],
        vercel__remove_project_domain: [{ args: { ...p, domain: 'www.example.com' } }],
        vercel__get_firewall_config: [{ args: p }],
        vercel__toggle_firewall: [{ args: { ...p, enabled: true } }],
        vercel__upsert_firewall_rule: [
          { args: { ...p, name: 'r', active: true, conditionGroup: [], action: { type: 'deny' } } },
        ],
        vercel__remove_firewall_rule: [{ args: { ...p, ruleId: 'rule_1' } }],
        vercel__manage_ip_blocking: [{ args: { ...p, operation: 'insert', ip: '10.0.0.1' } }],
        vercel__change_toolbar_thread_resolve_status: [
          { args: { ...p, threadId: 'thr_1', resolved: true } },
        ],
        vercel__reply_to_toolbar_thread: [{ args: { ...p, threadId: 'thr_1', markdown: 'x' } }],
        vercel__edit_toolbar_message: [
          { args: { ...p, threadId: 'thr_1', messageId: 'msg_1', markdown: 'x' } },
        ],
        vercel__add_toolbar_reaction: [
          { args: { ...p, threadId: 'thr_1', messageId: 'msg_1', emoji: '+1' } },
        ],
      },
      { resources: [app, foreign] },
    );
    expect(report.toolsChecked).toBe(31);
    // Every named risk is reached by at least one tool. The fallback is left
    // out on purpose : whether it co-fires with a specific write is the
    // policy engine's rule (P1.2-SDK changes it), not this plugin's.
    const named = vercelPlugin.catalog.risks
      .map((r) => r.id)
      .filter((id) => id !== 'vercel.uncategorized-write');
    expect(report.risksTouched).toEqual(expect.arrayContaining(named));
    expect(report.risksUntouched.filter((id) => id !== 'vercel.uncategorized-write')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v5 classifier conventions (the v4 cases are in risk-classifier.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyVercel — project resolution against mission resources', () => {
  const slices = (tool: string, args: Record<string, unknown>, resources: readonly Resource[]) => {
    const out = classifyVercel(tool, args, resources);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };

  test('projectId defaults to the single Vercel resource of the mission', () => {
    expect(slices('vercel__get_project', {}, [app, foreign])).toEqual([
      'vercel.project[prj_abc].project-settings.R',
    ]);
    expect(
      slices('vercel__get_access_to_vercel_url', { url: 'https://x.vercel.app/' }, [app]),
    ).toEqual(['vercel.project[prj_abc].deployment[*].bypass-token.W']);
  });

  test('refuses a project the mission does not hold, an ambiguous or missing one, a malformed ref', () => {
    expect(classifyVercel('vercel__get_project', { projectId: 'prj_other' }, [app])).toEqual({
      denied: "vercel project 'prj_other' is not a resource of this mission.",
    });
    expect(classifyVercel('vercel__list_env_vars', {}, [app, site])).toEqual({
      denied: 'projectId: argument missing and the mission touches 2 Vercel projects — name one',
    });
    expect(classifyVercel('vercel__list_env_vars', {}, [foreign])).toEqual({
      denied: 'projectId: argument missing and the mission touches no Vercel project',
    });
    expect(classifyVercel('vercel__list_env_vars', { projectId: 'prj abc' }, [app])).toEqual({
      denied: 'projectId: malformed project ref',
    });
    expect(classifyVercel('vercel__list_env_vars', { projectId: 42 }, [app])).toEqual({
      denied: 'projectId: malformed project ref',
    });
  });

  test('account-level tools need no project but still refuse a foreign projectId', () => {
    expect(slices('vercel__list_teams', {}, [])).toEqual(['vercel.account.team[*].R']);
    expect(slices('vercel__list_projects', {}, [app, site])).toEqual([
      'vercel.account.project[*].R',
    ]);
    expect(classifyVercel('vercel__list_projects', { projectId: 'prj_other' }, [app])).toEqual({
      denied: "vercel project 'prj_other' is not a resource of this mission.",
    });
  });

  test('unknown tool is refused before any project resolution', () => {
    expect(classifyVercel('vercel__drop_everything', {}, [])).toEqual({
      denied: "unknown vercel tool 'vercel__drop_everything'.",
    });
  });

  test('upsert with only unknown targets fans out to the three envs ; prod literal accepted', () => {
    const out = slices('vercel__upsert_env_var', { key: 'K', value: 'v', target: ['nope'] }, [app]);
    expect(out).toHaveLength(4);
    expect(out).toContain('vercel.project[prj_abc].env-var-fan-out.W');
    expect(slices('vercel__deploy_to_vercel', { target: 'prod' }, [app])).toEqual([
      'vercel.project[prj_abc].env[prod].deployment.W',
    ]);
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices('vercel__delete_env_var', { id: 'env_1' }, [app])) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('vercelEnvOf — the environment a slice touches', () => {
  test('reads the env[<label>] segment, null when env-less', () => {
    expect(vercelEnvOf(parseSlice('vercel.project[prj_abc].env[prod].deployment.W'))).toBe('prod');
    expect(vercelEnvOf(parseSlice('vercel.project[prj_abc].env[preview].env-var[K].W'))).toBe(
      'preview',
    );
    expect(vercelEnvOf(parseSlice('vercel.project[prj_abc].project-settings.W'))).toBeNull();
    expect(vercelEnvOf(parseSlice('vercel.account.team[*].R'))).toBeNull();
    expect(vercelEnvOf(parseSlice('github.repo[a/b].branch[main].W'))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential
// ─────────────────────────────────────────────────────────────────────────────

describe('vercel credential spec', () => {
  test('api-key with a secret token and a non-secret team id constrained to team_…', () => {
    expect(vercelCredential.kind).toBe('api-key');
    const token = vercelCredential.fields.find((f) => f.name === 'token')!;
    const team = vercelCredential.fields.find((f) => f.name === 'team_id')!;
    expect(token.secret).toBe(true);
    expect(team.secret).toBe(false);
    expect(new RegExp(team.pattern!).test('team_nllPyCtREAqxxdyFKbbMDlxd')).toBe(true);
    expect(new RegExp(team.pattern!).test('my-team')).toBe(false);
    expect('refresh' in vercelPlugin).toBe(false);
  });

  test('vercelAuth narrows the secret and refuses the wrong kind or a missing field', () => {
    expect(vercelAuth(credential)).toEqual({ token: 'vcp_secret', teamId: 'team_abc' });
    expect(() =>
      vercelAuth({
        kind: 'oauth2',
        accessToken: 'x',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        metadata: {},
      }),
    ).toThrow(CredentialKindMismatch);
    expect(() => vercelAuth({ kind: 'api-key', fields: { token: 'x' }, metadata: {} })).toThrow(
      /team_id/,
    );
    expect(() =>
      vercelAuth({ kind: 'api-key', fields: { token: 'x', team_id: 'slug' }, metadata: {} }),
    ).toThrow(/team_/);
    expect(() =>
      vercelAuth({ kind: 'api-key', fields: { team_id: 'team_abc' }, metadata: {} }),
    ).toThrow(/token/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute
// ─────────────────────────────────────────────────────────────────────────────

describe('executeVercel with mockFetch', () => {
  test('forwards a rewrapped tool as JSON-RPC with the bearer and the connection team, passes the MCP result through', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: VERCEL_MCP_URL,
        respond: (c) => sseFrame(c, { content: [{ type: 'text', text: '{"projects":[]}' }] }),
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_projects', {});
    expect(result).toEqual({ content: [{ type: 'text', text: '{"projects":[]}' }] });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer vcp_secret');
    expect(call.headers.accept).toContain('text/event-stream');
    expect(call.json).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_projects', arguments: { teamId: 'team_abc' } },
    });
  });

  test('does not inject teamId or projectId into a tool whose schema does not declare them', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: VERCEL_MCP_URL, respond: (c) => sseFrame(c, { content: [] }) },
    ]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__get_access_to_vercel_url', {
      url: 'https://x.vercel.app/',
    });
    expect((fetch.calls[0]!.json as { params: { arguments: unknown } }).params.arguments).toEqual({
      url: 'https://x.vercel.app/',
    });
  });

  test('fills projectId from the single mission project on a custom REST tool', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc`,
        body: { envs: [{ id: 'env_1', key: 'K' }] },
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_env_vars', {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      envs: [{ id: 'env_1', key: 'K' }],
    });
  });

  test('refuses a teamId that is not the connection team before any network call', async () => {
    const fetch = mockFetch([]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_projects', {
      teamId: 'team_other',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/team_other/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('upsert_env_var POSTs the whitelisted body with upsert=true', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: /\/v10\/projects\/prj_abc\/env\?/, respond: (c) => c.json },
    ]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'K',
      value: 'v',
      target: ['preview'],
      sneaky: 'dropped',
    });
    const call = fetch.calls[0]!;
    expect(call.url).toBe(
      `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc&upsert=true`,
    );
    expect(call.json).toEqual({ key: 'K', value: 'v', target: ['preview'] });
  });

  test('401 / 403 become UpstreamAuthError on both surfaces', async () => {
    const mcp = mockFetch([{ url: VERCEL_MCP_URL, status: 401, body: 'Unauthorized' }]);
    await expect(vercelPlugin.execute(ctx(mcp), 'vercel__list_projects', {})).rejects.toMatchObject(
      { name: 'UpstreamAuthError', upstreamStatus: 401 },
    );
    const rest = mockFetch([{ url: /\/v10\/projects\/prj_abc\/env/, status: 403, body: {} }]);
    await expect(
      vercelPlugin.execute(ctx(rest), 'vercel__list_env_vars', { projectId: 'prj_abc' }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 403 });
  });

  test('other upstream failures come back as isError results the agent can read', async () => {
    const rpc = mockFetch([
      { url: VERCEL_MCP_URL, respond: (c) => sseError(c, -32602, 'invalid args') },
    ]);
    const r1 = await vercelPlugin.execute(ctx(rpc), 'vercel__get_project', {
      projectId: 'prj_abc',
    });
    expect(r1.isError).toBe(true);
    expect((r1.content[0] as { text: string }).text).toMatch(/invalid args/);

    const http = mockFetch([{ url: /\/v9\/projects\/prj_abc\?/, status: 500, body: 'boom' }]);
    const r2 = await vercelPlugin.execute(ctx(http), 'vercel__update_project_settings', {
      projectId: 'prj_abc',
      framework: 'nextjs',
    });
    expect(r2.isError).toBe(true);
    expect((r2.content[0] as { text: string }).text).toMatch(/500/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverResources
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverVercelResources with mockFetch', () => {
  const teamRoute = {
    method: 'GET',
    url: `${VERCEL_API_BASE}/v2/teams/team_abc`,
    body: { id: 'team_abc', slug: 'acme', name: 'Acme' },
  };

  test('reads the team, pages the projects, maps each to a resource with the env axis noted', async () => {
    const fetch = mockFetch([
      teamRoute,
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v10/projects?teamId=team_abc&limit=100`,
        body: {
          projects: [
            { id: 'prj_a', name: 'a', framework: 'nextjs' },
            { id: 'prj_b', name: 'b', framework: null },
          ],
          pagination: { count: 2, next: 1700000000000, prev: null },
        },
      },
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v10/projects?teamId=team_abc&limit=100&until=1700000000000`,
        body: { projects: [{ id: 'prj_c', name: 'c' }], pagination: { count: 1, next: null } },
      },
    ]);
    const resources = await vercelPlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual(['prj_a', 'prj_b', 'prj_c']);
    expect(resources[0]).toEqual({
      provider: 'vercel',
      ref: 'prj_a',
      displayName: 'a',
      metadata: {
        team_id: 'team_abc',
        team_slug: 'acme',
        team_name: 'Acme',
        framework: 'nextjs',
        environments: ['prod', 'preview', 'development'],
      },
    });
    expect(resources[2]!.metadata).toMatchObject({ framework: null });
    expect(fetch.calls).toHaveLength(3);
    expect(fetch.calls.every((c) => c.headers.authorization === 'Bearer vcp_secret')).toBe(true);
  });

  test('stops after DISCOVERY_MAX_PAGES pages even when the API keeps paginating', async () => {
    let page = 0;
    const fetch = mockFetch([
      teamRoute,
      {
        method: 'GET',
        url: /\/v10\/projects\?/,
        respond: () => {
          page += 1;
          return {
            projects: [{ id: `prj_${page}`, name: `p${page}` }],
            pagination: { next: page },
          };
        },
      },
    ]);
    const resources = await vercelPlugin.discoverResources(ctx(fetch));
    expect(resources).toHaveLength(DISCOVERY_MAX_PAGES);
    expect(fetch.calls).toHaveLength(1 + DISCOVERY_MAX_PAGES);
  });

  test('a rejected token surfaces as UpstreamAuthError from the team check', async () => {
    const fetch = mockFetch([{ url: /\/v2\/teams\//, status: 403, body: { error: 'forbidden' } }]);
    await expect(vercelPlugin.discoverResources(ctx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
  });
});
