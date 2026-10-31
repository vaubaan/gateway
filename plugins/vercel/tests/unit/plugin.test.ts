/**
 * Mandatory suite of the `vercel` plugin : the SDK kit, the classifier
 * conventions (project resolution against mission resources), the credential
 * spec, `execute` and `discoverResources` against `mockFetch`.
 *
 * The per-tool slice shapes of the classifier are in `classify.test.ts`.
 * No test ever reaches the network : an unmatched request rejects.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialKindMismatch,
  parseSlice,
  serializeSlice,
  type EnvOf,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  mockFetch,
  policyFromMacroActions,
  type RecordedCall,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';
import { envResolverFor, NO_SINGLE_ENV } from '@vaubaan/policy-engine';

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
  return { credential, fetch, resources };
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
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(vercelPlugin);
    assertNoWildcard(vercelPlugin);
  });

  test('macro-actions : watch, deploy, configure, protect, own ; the fallback in none', () => {
    const actions = vercelPlugin.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['watch', 'deploy', 'configure', 'protect', 'own']);
    const listed = actions.flatMap((a) => a.entries.map((e) => e.risk_id));
    expect(listed).not.toContain('vercel.uncategorized-write');
  });

  test('a developer mission (watch and deploy on preview) never touches production configuration', () => {
    const developer = policyFromMacroActions(
      vercelPlugin,
      { watch: 'confiant', deploy: 'confiant' },
      { envs: ['preview', 'development'] },
    );
    const risks = developer.map((line) => line.risk_id);
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
    expect(developer).toContainEqual(
      expect.objectContaining({ risk_id: 'vercel[preview].deploy', gate: 'auto' }),
    );
  });

  test('an operator mission at Confiant asks first for production deploys and configuration', () => {
    const operator = policyFromMacroActions(
      vercelPlugin,
      { watch: 'confiant', deploy: 'confiant', configure: 'confiant', own: 'confiant' },
      { envs: ['preview', 'development', 'prod'] },
    );
    const gated = operator.filter((e) => e.gate === 'approval').map((e) => e.risk_id);
    expect(gated).toEqual(
      expect.arrayContaining([
        'vercel[prod].deploy',
        'vercel[prod].env-var-write',
        'vercel.env-var-fan-out',
        'vercel.project-settings-write',
        'vercel.domain-write',
      ]),
    );
    expect(gated).not.toContain('vercel[preview].env-var-write');
  });

  const p = { projectId: 'prj_abc' };
  // One table for the catalog coverage and for the identifier proof.
  const SAMPLES: ToolSamples = {
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
    vercel__get_toolbar_thread: [{ args: { ...p, threadId: 'thr_1' }, expectDenied: true }],
    vercel__list_env_vars: [{ args: p }, { args: { ...p, decrypt: true } }],
    vercel__deploy_to_vercel: [{ args: p }, { args: {} }],
    vercel__get_access_to_vercel_url: [{ args: { url: 'https://app-git-main.vercel.app/' } }],
    vercel__upsert_env_var: [
      { args: { ...p, key: 'K', value: 'v', target: ['preview'] } },
      { args: { ...p, key: 'K', value: 'v' } },
      {
        args: { ...p, key: 'K', value: 'v', target: ['preview', 'staging'] },
        expectDenied: true,
      },
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
    // The four thread-addressed writes are refused : a thread cannot be bound to a project.
    vercel__change_toolbar_thread_resolve_status: [
      { args: { ...p, threadId: 'thr_1', resolved: true }, expectDenied: true },
    ],
    vercel__reply_to_toolbar_thread: [
      { args: { ...p, threadId: 'thr_1', markdown: 'x' }, expectDenied: true },
    ],
    vercel__edit_toolbar_message: [
      {
        args: { ...p, threadId: 'thr_1', messageId: 'msg_1', markdown: 'x' },
        expectDenied: true,
      },
    ],
    vercel__add_toolbar_reaction: [
      {
        args: { ...p, threadId: 'thr_1', messageId: 'msg_1', emoji: '+1' },
        expectDenied: true,
      },
    ],
  };

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(vercelPlugin, SAMPLES, { resources: [app, foreign] });
    expect(report.toolsChecked).toBe(31);
    // Every named risk but one is reached by at least one tool ; no sample
    // lands on the fallback (ADR fallback-risk-only-when-uncategorized).
    // `vercel.toolbar-write` stays in the catalog (risk ids are stable) but no
    // tool reaches it while the thread-addressed tools are refused.
    const unreachable = ['vercel.toolbar-write'];
    const named = vercelPlugin.catalog.risks
      .map((r) => r.id)
      .filter((id) => id !== 'vercel.uncategorized-write' && !unreachable.includes(id));
    expect(report.risksTouched).toEqual(named);
    expect(report.risksUntouched).toEqual(unreachable);
    expect(report.fallbackHits).toEqual([]);
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(vercelPlugin, SAMPLES, {
      resources: [app, foreign],
      context: (fetch, resources) => ctx(fetch, resources),
    });
    // 26 of 31 : the five thread-addressed tools are refused whatever they are given.
    expect(report.toolsChecked).toBe(26);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'deploymentId',
      'domain',
      'id',
      'idOrUrl',
      'projectId',
    ]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Classifier conventions (the per-tool slice shapes are in classify.test.ts)
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
    // The URL is not proof of ownership : `execute` verifies the deployment
    // belongs to this project before the upstream call (binding.test.ts).
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

  test('upsert with an unknown target is refused ; a deploy is on prod whatever the arguments', () => {
    const refused = classifyVercel(
      'vercel__upsert_env_var',
      { key: 'K', value: 'v', target: ['nope'] },
      [app],
    );
    expect('denied' in refused ? refused.denied : null).toMatch(/^target: expected an array of/);
    expect(slices('vercel__deploy_to_vercel', {}, [app])).toEqual([
      'vercel.project[prj_abc].env[prod].deployment.W',
    ]);
    // The upstream deploy tool has no `target` : naming one is refused, never ignored.
    expect(classifyVercel('vercel__deploy_to_vercel', { target: 'preview' }, [app])).toEqual({
      denied:
        "target: not an argument of 'vercel__deploy_to_vercel' — nothing classifies it, so it is not sent.",
    });
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

  test('the plugin declares it as envOf ; the host composes it before the resource label', () => {
    const envOf: EnvOf = vercelPlugin.envOf;
    expect(envOf(parseSlice('vercel.project[prj_abc].env[prod].env-var[K].W'), [app])).toBe('prod');
    expect(envOf(parseSlice('vercel.project[prj_abc].domain[x].W'), [app])).toBeUndefined();

    // `envResolverFor` : the slice's own env wins over an owner label that
    // disagrees ; an env-less slice falls back to that label.
    const labelledStaging: Resource = { ...app, env: 'staging' };
    const resolver = envResolverFor([labelledStaging], envOf);
    expect(resolver.resolveEnv(parseSlice('vercel.project[prj_abc].env[prod].env-var[K].W'))).toBe(
      'prod',
    );
    expect(resolver.resolveEnv(parseSlice('vercel.project[prj_abc].project-settings.W'))).toBe(
      'staging',
    );
  });

  test.each([
    'vercel.project[prj_abc].env[*].env-var[K].W',
    'vercel.project[prj_abc].env[**].W',
    'vercel.project[prj_abc].env[prod,preview].env-var[K].W',
    'vercel.project[prj_abc].env[prod*].env-var[K].W',
    'vercel.project[prj_abc].env[staging].env-var[K].W',
  ])(
    '%s names no single environment of the triad: none is resolved, the label is not used',
    (s) => {
      expect(vercelEnvOf(parseSlice(s))).toBe(NO_SINGLE_ENV);
      const labelledStaging: Resource = { ...app, env: 'staging' };
      const resolver = envResolverFor([labelledStaging], vercelPlugin.envOf);
      expect(resolver.resolveEnv(parseSlice(s))).toBeNull();
    },
  );

  test('no slice the classifier emits names several environments', () => {
    // `upsert_env_var` without a target reaches all three: one slice per environment.
    const out = classifyVercel('vercel__upsert_env_var', { key: 'K', value: 'v' }, [app]);
    if (!('slices' in out)) throw new Error('expected slices');
    expect(out.slices.map((s) => vercelEnvOf(s))).not.toContain(NO_SINGLE_ENV);
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
    // The project answer is re-serialized by the project filter (`project-redact.ts`).
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ projects: [] });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer vcp_secret');
    expect(call.headers.accept).toContain('text/event-stream');
    expect(call.json).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_projects', arguments: { teamId: 'team_abc' } },
    });
  });

  test('sends neither teamId nor projectId to a tool whose closed schema has none, even when given', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: VERCEL_MCP_URL, respond: (c) => sseFrame(c, { content: [] }) },
    ]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__search_vercel_documentation', {
      topic: 'routing',
      teamId: 'team_abc',
      projectId: 'prj_abc',
    });
    expect((fetch.calls[0]!.json as { params: { arguments: unknown } }).params.arguments).toEqual({
      topic: 'routing',
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
    expect((result.content[0] as { text: string }).text).toMatch(
      /teamId is fixed by the connection \('team_abc'\)/,
    );
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
    });
    const call = fetch.calls[0]!;
    expect(call.url).toBe(
      `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc&upsert=true`,
    );
    expect(call.json).toEqual({ key: 'K', value: 'v', target: ['preview'] });
  });

  test.each<[string, Record<string, unknown>]>([
    ['vercel__upsert_env_var', { projectId: 'prj_abc', key: 'K', value: 'v', sneaky: 'x' }],
    ['vercel__update_project_settings', { projectId: 'prj_abc', rootDirectory: 'app', sneaky: 1 }],
    ['vercel__add_project_domain', { projectId: 'prj_abc', name: 'www.example.com', sneaky: {} }],
    // `customEnvironmentId` is a field of the provider's API the tool does not declare.
    [
      'vercel__add_project_domain',
      { projectId: 'prj_abc', name: 'www.example.com', customEnvironmentId: 'env_1' },
    ],
    ['vercel__get_project', { projectId: 'prj_abc', project_id: 'prj_other' }],
    ['vercel__deploy_to_vercel', { projectId: 'prj_abc', target: 'preview' }],
    ['vercel__list_teams', { limit: 5 }],
  ])(
    '%s with an argument it does not declare is refused on both sides : nothing is sent',
    async (tool, args) => {
      const undeclared = Object.keys(args).at(-1)!;
      const reason = `${undeclared}: not an argument of '${tool}' — nothing classifies it, so it is not sent.`;
      expect(classifyVercel(tool, args, [app])).toEqual({ denied: reason });
      const fetch = mockFetch([]);
      const result = await vercelPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(reason);
      expect(fetch.calls).toHaveLength(0);
    },
  );

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

  test('a provider failure is thrown, with its status when it has one (never an isError result)', async () => {
    const rpc = mockFetch([
      { url: VERCEL_MCP_URL, respond: (c) => sseError(c, -32602, 'invalid args') },
    ]);
    await expect(
      vercelPlugin.execute(ctx(rpc), 'vercel__get_project', { projectId: 'prj_abc' }),
    ).rejects.toThrow(/invalid args/);

    const http = mockFetch([{ url: /\/v9\/projects\/prj_abc\?/, status: 500, body: 'boom' }]);
    await expect(
      vercelPlugin.execute(ctx(http), 'vercel__update_project_settings', {
        projectId: 'prj_abc',
        framework: 'nextjs',
      }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 500 });

    const mcp = mockFetch([{ url: VERCEL_MCP_URL, status: 502, body: 'bad gateway' }]);
    await expect(
      vercelPlugin.execute(ctx(mcp), 'vercel__get_project', { projectId: 'prj_abc' }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 502 });
  });

  test('a network failure is thrown as it is, not turned into a result', async () => {
    const down = mockFetch([
      {
        url: /\/v9\/projects\/prj_abc\?/,
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    await expect(
      vercelPlugin.execute(ctx(down), 'vercel__update_project_settings', {
        projectId: 'prj_abc',
        framework: 'nextjs',
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test('what the executor declines itself stays an isError result, with no network call', async () => {
    const none = mockFetch([]);
    const result = await vercelPlugin.execute(ctx(none), 'vercel__toggle_firewall', {
      projectId: 'prj_abc',
      enabled: 'yes',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/enabled \(boolean\) is required/);
    expect(none.calls).toHaveLength(0);
  });
});

describe('executeVercel — request shapes of the custom REST tools', () => {
  const text = (result: { content: readonly unknown[] }) =>
    (result.content[0] as { text: string }).text;

  test('declares the custom tools next to the rewrapped ones', () => {
    const names = vercelPlugin.tools.map((t) => t.name);
    for (const expected of [
      'vercel__list_projects',
      'vercel__update_project_settings',
      'vercel__upsert_env_var',
      'vercel__list_env_vars',
      'vercel__delete_env_var',
      'vercel__list_project_domains',
      'vercel__add_project_domain',
      'vercel__verify_project_domain',
      'vercel__remove_project_domain',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('vercel__update_deployment_protection');
  });

  test('accepts an explicit teamId equal to the connection team', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: VERCEL_MCP_URL, respond: (c) => sseFrame(c, { content: [] }) },
    ]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__list_projects', { teamId: 'team_abc' });
    expect((fetch.calls[0]!.json as { params: { arguments: unknown } }).params.arguments).toEqual({
      teamId: 'team_abc',
    });
  });

  test('update_project_settings PATCHes /v9/projects/{id} with the whitelisted fields and the team query', async () => {
    const fetch = mockFetch([
      {
        method: 'PATCH',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc?teamId=team_abc`,
        body: { id: 'prj_abc', rootDirectory: 'app' },
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__update_project_settings', {
      projectId: 'prj_abc',
      rootDirectory: 'app',
      framework: 'nextjs',
    });
    expect(JSON.parse(text(result))).toEqual({ id: 'prj_abc', rootDirectory: 'app' });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer vcp_secret');
    expect(call.json).toEqual({ rootDirectory: 'app', framework: 'nextjs' });
  });

  test('a custom tool without a resolvable projectId fails before any network call', async () => {
    const fetch = mockFetch([]);
    // Two projects : `execute` cannot default the argument.
    const result = await vercelPlugin.execute(
      ctx(fetch, [app, site]),
      'vercel__update_project_settings',
      { rootDirectory: 'app' },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/projectId: argument missing and the mission touches 2/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('upsert_env_var keeps type and comment in the body', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc&upsert=true`,
        body: { created: { key: 'DATABASE_URL' } },
      },
    ]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'DATABASE_URL',
      value: 'postgres://...',
      target: ['production', 'preview'],
      type: 'encrypted',
      comment: 'set by gateway',
    });
    expect(fetch.calls[0]!.json).toEqual({
      key: 'DATABASE_URL',
      value: 'postgres://...',
      target: ['production', 'preview'],
      type: 'encrypted',
      comment: 'set by gateway',
    });
  });

  test('list_env_vars GETs without a body ; decrypt=true reaches the query', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc`,
        body: { envs: [{ id: 'env_a', key: 'X', target: ['production'] }] },
      },
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc&decrypt=true`,
        body: { envs: [] },
      },
    ]);
    const listed = await vercelPlugin.execute(ctx(fetch), 'vercel__list_env_vars', {
      projectId: 'prj_abc',
    });
    expect(JSON.parse(text(listed))).toEqual({
      envs: [{ id: 'env_a', key: 'X', target: ['production'] }],
    });
    expect(fetch.calls[0]!.body).toBeNull();
    expect(fetch.calls[0]!.headers['content-type']).toBeUndefined();

    await vercelPlugin.execute(ctx(fetch), 'vercel__list_env_vars', {
      projectId: 'prj_abc',
      decrypt: true,
    });
    expect(fetch.calls[1]!.url).toBe(
      `${VERCEL_API_BASE}/v10/projects/prj_abc/env?teamId=team_abc&decrypt=true`,
    );
  });

  test('delete_env_var DELETEs /v9/projects/{id}/env/{envId} without a body ; a missing id fails first', async () => {
    const fetch = mockFetch([
      {
        method: 'DELETE',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc/env/env_xyz?teamId=team_abc`,
        body: {},
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__delete_env_var', {
      projectId: 'prj_abc',
      id: 'env_xyz',
    });
    expect(result.isError).toBeUndefined();
    expect(fetch.calls[0]!.body).toBeNull();

    const missing = await vercelPlugin.execute(ctx(fetch), 'vercel__delete_env_var', {
      projectId: 'prj_abc',
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/id is required/);
    expect(fetch.calls).toHaveLength(1);
  });

  test('list_project_domains GETs /v9/projects/{id}/domains with the team query', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc/domains?teamId=team_abc`,
        body: { domains: [{ name: 'example.com', verified: true }] },
      },
    ]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__list_project_domains', {
      projectId: 'prj_abc',
    });
    expect(JSON.parse(text(result))).toEqual({
      domains: [{ name: 'example.com', verified: true }],
    });
    expect(fetch.calls[0]!.body).toBeNull();
  });

  test('add_project_domain POSTs the whitelisted body ; a missing name fails first', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${VERCEL_API_BASE}/v10/projects/prj_abc/domains?teamId=team_abc`,
        body: { name: 'www.example.com', verified: false },
      },
    ]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__add_project_domain', {
      projectId: 'prj_abc',
      name: 'www.example.com',
      gitBranch: 'main',
    });
    expect(fetch.calls[0]!.json).toEqual({ name: 'www.example.com', gitBranch: 'main' });

    const missing = await vercelPlugin.execute(ctx(fetch), 'vercel__add_project_domain', {
      projectId: 'prj_abc',
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/name is required/);
    expect(fetch.calls).toHaveLength(1);
  });

  test('verify_project_domain POSTs …/domains/{domain}/verify ; remove_project_domain DELETEs …/domains/{domain}', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc/domains/www.example.com/verify?teamId=team_abc`,
        body: { verified: true },
      },
      {
        method: 'DELETE',
        url: `${VERCEL_API_BASE}/v9/projects/prj_abc/domains/www.example.com?teamId=team_abc`,
        body: {},
      },
    ]);
    const verified = await vercelPlugin.execute(ctx(fetch), 'vercel__verify_project_domain', {
      projectId: 'prj_abc',
      domain: 'www.example.com',
    });
    expect(JSON.parse(text(verified))).toEqual({ verified: true });

    const removed = await vercelPlugin.execute(ctx(fetch), 'vercel__remove_project_domain', {
      projectId: 'prj_abc',
      domain: 'www.example.com',
    });
    expect(removed.isError).toBeUndefined();
    expect(fetch.calls[1]!.method).toBe('DELETE');
    expect(fetch.calls[1]!.body).toBeNull();
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

  test('a token scoped to projects, refused the team, still lists its projects', async () => {
    const fetch = mockFetch([
      { url: /\/v2\/teams\//, status: 403, body: { error: 'forbidden' } },
      {
        method: 'GET',
        url: `${VERCEL_API_BASE}/v10/projects?teamId=team_abc&limit=100`,
        body: { projects: [{ id: 'prj_a', name: 'a' }], pagination: { next: null } },
      },
    ]);
    const resources = await vercelPlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual(['prj_a']);
    expect(resources[0]!.metadata).toEqual({
      team_id: 'team_abc',
      framework: null,
      environments: ['prod', 'preview', 'development'],
    });
  });

  test('a rejected token surfaces as UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { url: /\/v2\/teams\//, status: 403, body: { error: 'forbidden' } },
      { url: /\/v10\/projects\?/, status: 403, body: { error: 'forbidden' } },
    ]);
    await expect(vercelPlugin.discoverResources(ctx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
  });

  test('an invalid token surfaces as UpstreamAuthError from the team check', async () => {
    const fetch = mockFetch([{ url: /\/v2\/teams\//, status: 401, body: { error: 'invalid' } }]);
    await expect(vercelPlugin.discoverResources(ctx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });
});
