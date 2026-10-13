/**
 * Mandatory test suite of the Railway plugin : the SDK kit, the v5
 * classifier on `Resource[]`, the credential spec, `execute`
 * and `discoverResources` against `mockFetch`. No network, ever.
 *
 * The v4 classifier behaviour is covered unchanged by
 * `risk-classifier.test.ts` through the `classifyRailwayV4` bridge.
 */
import { describe, expect, test } from 'vitest';

import {
  parseSlice,
  serializeSlice,
  type ConnectionContext,
  type ExecuteContext,
  type OAuth2Secret,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';

import {
  RAILWAY_AGENT_HINT,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_RESOURCE,
  RAILWAY_MCP_URL,
  RAILWAY_TOKEN_URL,
  classifyRailway,
  environmentsOf,
  railwayPlugin,
} from '../../src/index.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROJECT_STG = '00000000-0000-4000-8000-000000000001';
const PROJECT_PRD = '00000000-0000-4000-8000-000000000002';
const SERVICE = '00000000-0000-4000-8000-00000000000a';
const ENV_STG = '00000000-0000-4000-8000-0000000000e1';
const ENV_PRD = '00000000-0000-4000-8000-0000000000e2';

const staging: Resource = {
  provider: 'railway',
  ref: PROJECT_STG,
  env: 'staging',
  displayName: 'api (staging)',
  metadata: { environments: [{ id: ENV_STG, name: 'staging' }] },
};
const prod: Resource = {
  provider: 'railway',
  ref: PROJECT_PRD,
  env: 'prod',
  displayName: 'api (prod)',
  metadata: { environments: [{ id: ENV_PRD, name: 'production' }] },
};
const unlabelled: Resource = { provider: 'railway', ref: PROJECT_STG, displayName: 'api' };
const foreign: Resource = { provider: 'vercel', ref: 'prj_1', displayName: 'other' };

const secret = (over: Partial<OAuth2Secret> = {}): OAuth2Secret => ({
  kind: 'oauth2',
  accessToken: 'rlwy_at',
  refreshToken: 'rlwy_rt',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scopes: ['openid', 'offline_access', 'workspace:member'],
  metadata: {},
  ...over,
});

const connCtx = (
  fetch: typeof globalThis.fetch,
  over: Partial<ConnectionContext> = {},
): ConnectionContext => ({
  credential: secret(),
  appConfig: { client_id: 'cid', client_secret: 'csecret' },
  fetch,
  ...over,
});

const execCtx = (
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [staging],
): ExecuteContext => ({ ...connCtx(fetch), resources });

/** An SSE-framed JSON-RPC answer, as mcp.railway.com sends it. */
function sseFrame(call: { json: unknown }, result: unknown): string {
  const id = (call.json as { id: number }).id;
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

// ─── Structural kit ──────────────────────────────────────────────────────────

describe('railway plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(railwayPlugin);
    assertPresetsValid(railwayPlugin);
    assertNoWildcard(railwayPlugin);
  });

  test('ships the three presets of the brief, every risk id explicit', () => {
    const presets = railwayPlugin.catalog.presets ?? [];
    expect(presets.map((p) => p.id)).toEqual(['read-only', 'developer', 'operator']);
    const dev = presets.find((p) => p.id === 'developer')!;
    expect(dev.entries.find((e) => e.risk_id === 'railway[prod].deploy')?.gate).toBe('approval');
    expect(dev.entries.find((e) => e.risk_id === 'railway[staging].deploy')?.gate).toBe('auto');
    expect(dev.entries.some((e) => e.risk_id === 'railway.agent-action')).toBe(false);
    for (const p of presets) for (const e of p.entries) expect(e.quota).toBeGreaterThan(0);
  });

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(
      railwayPlugin,
      {
        railway__whoami: [{ args: {} }],
        'railway__list-projects': [{ args: {} }],
        'railway__create-project': [{ args: { name: 'new' } }],
        'railway__list-services': [{ args: { projectId: PROJECT_STG } }, { args: {} }],
        'railway__list-deployments': [{ args: { projectId: PROJECT_STG, limit: 10 } }],
        'railway__get-status': [{ args: { projectId: PROJECT_STG, environmentId: ENV_STG } }],
        'railway__get-logs': [
          { args: { projectId: PROJECT_STG, serviceId: SERVICE, environmentId: ENV_STG } },
        ],
        railway__redeploy: [
          { args: { projectId: PROJECT_STG, serviceId: SERVICE, environmentId: ENV_STG } },
          {
            args: { projectId: PROJECT_PRD, serviceId: SERVICE, environmentId: ENV_PRD },
            resources: [staging, prod],
          },
        ],
        'railway__accept-deploy': [
          { args: { environmentId: ENV_STG } },
          // two projects, no projectId : resolved through the discovered environments.
          { args: { environmentId: ENV_PRD }, resources: [staging, prod] },
        ],
        'railway__railway-agent': [
          { args: { projectId: PROJECT_STG, environmentId: ENV_STG, message: 'scale the worker' } },
        ],
        'railway__list-variables': [{ args: { projectId: PROJECT_STG, environmentId: ENV_STG } }],
        'railway__upsert-variable': [
          { args: { projectId: PROJECT_STG, environmentId: ENV_STG, name: 'API_KEY', value: 'x' } },
        ],
        'railway__upsert-variables': [
          { args: { projectId: PROJECT_STG, environmentId: ENV_STG, variables: { A: '1' } } },
          {
            args: {
              projectId: PROJECT_STG,
              environmentId: ENV_STG,
              variables: { A: '1' },
              replace: true,
            },
          },
          // two projects, an environment none of them declares : ambiguous.
          {
            args: { environmentId: 'env-unknown', variables: { A: '1' } },
            resources: [staging, prod],
            expectDenied: true,
          },
        ],
        'railway__delete-variable': [
          { args: { projectId: PROJECT_STG, environmentId: ENV_STG, name: 'OLD' } },
        ],
      },
      { resources: [staging] },
    );
    expect(report.toolsChecked).toBe(14);
    // A categorized write touches its entry alone (ADR
    // fallback-risk-only-when-uncategorized) : the nine specific risks, no fallback.
    expect(report.risksTouched).toEqual([
      'railway.read-account',
      'railway.read-runtime',
      'railway.read-logs',
      'railway.read-variables',
      'railway.deploy',
      'railway.upsert-variable',
      'railway.bulk-variables-replace',
      'railway.create-project',
      'railway.agent-action',
    ]);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });
});

// ─── v5 classifier on Resource[] ─────────────────────────────────────────────

describe('classifyRailway', () => {
  const slices = (
    tool: string,
    args: Record<string, unknown>,
    resources: readonly Resource[] = [staging],
  ) => {
    const out = classifyRailway(tool, args, resources);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };
  const denied = (
    tool: string,
    args: Record<string, unknown>,
    resources: readonly Resource[] = [staging],
  ) => {
    const out = classifyRailway(tool, args, resources);
    return 'denied' in out ? out.denied : `allowed with ${out.slices.length} slice(s)`;
  };

  test('stamps the owner label of the project into the environment segment', () => {
    expect(
      slices(
        'railway__redeploy',
        { projectId: PROJECT_PRD, serviceId: SERVICE, environmentId: ENV_PRD },
        [staging, prod],
      ),
    ).toEqual([
      `railway.project[${PROJECT_PRD}].environment[prod].service[${SERVICE}].deployment.W`,
    ]);
  });

  test('an unlabelled project yields a wildcard environment segment', () => {
    expect(slices('railway__list-variables', { environmentId: ENV_STG }, [unlabelled])).toEqual([
      `railway.project[${PROJECT_STG}].environment[*].service-var[*].R`,
    ]);
  });

  test('projectId defaults to the single Railway project, ignoring other providers', () => {
    expect(slices('railway__list-services', {}, [foreign, staging])).toEqual([
      `railway.project[${PROJECT_STG}].environment[*].service[*].R`,
    ]);
  });

  test('accept-deploy finds its project through the discovered environments', () => {
    expect(slices('railway__accept-deploy', { environmentId: ENV_PRD }, [staging, prod])).toEqual([
      `railway.project[${PROJECT_PRD}].environment[prod].service[*].deployment.W`,
    ]);
  });

  test('refuses an unknown project, an ambiguous target, a mission without Railway project', () => {
    expect(denied('railway__list-services', { projectId: PROJECT_PRD })).toBe(
      `railway project '${PROJECT_PRD}' is not a resource of this mission.`,
    );
    expect(denied('railway__list-services', {}, [staging, prod])).toBe(
      'ambiguous railway target: specify projectId.',
    );
    expect(
      denied('railway__accept-deploy', { environmentId: 'unknown-env' }, [staging, prod]),
    ).toBe('ambiguous railway target: specify projectId.');
    expect(denied('railway__list-services', {}, [foreign])).toMatch(/touches no Railway project/);
    expect(denied('railway__list-services', { projectId: 42 })).toBe('projectId: malformed ref.');
  });

  test('refuses malformed identifiers instead of embedding them in a slice', () => {
    expect(denied('railway__get-logs', { projectId: PROJECT_STG, serviceId: 'a b' })).toBe(
      'serviceId: malformed ref.',
    );
    expect(
      denied('railway__upsert-variable', { projectId: PROJECT_STG, name: 'BAD,NAME', value: 'x' }),
    ).toBe('name: malformed variable name.');
    expect(
      denied('railway__upsert-variables', { projectId: PROJECT_STG, variables: { 'A]': '1' } }),
    ).toBe('variables: malformed variable name.');
  });

  test('account-level tools need no resource and carry no environment', () => {
    expect(slices('railway__whoami', {}, [])).toEqual(['railway.account[*].R']);
    expect(slices('railway__create-project', { name: 'x' }, [])).toEqual([
      'railway.account[*].project.W',
    ]);
    expect(denied('railway__nope', {}, [])).toBe("unknown railway tool 'railway__nope'.");
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices('railway__railway-agent', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      message: 'hi',
    })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });

  test('environmentsOf tolerates missing or malformed metadata', () => {
    expect(environmentsOf(unlabelled)).toEqual([]);
    expect(environmentsOf({ ...unlabelled, metadata: { environments: 'nope' } })).toEqual([]);
    expect(
      environmentsOf({
        ...unlabelled,
        metadata: { environments: [{ id: 1 }, { id: 'e', name: 'n' }] },
      }),
    ).toEqual([{ id: 'e', name: 'n' }]);
  });
});

// ─── Credential spec ─────────────────────────────────────────────────────────

describe('railway credential', () => {
  test('declares the OAuth2 flow of the rewrap ADR', () => {
    expect(railwayPlugin.credential).toMatchObject({
      kind: 'oauth2',
      authorizationUrl: 'https://backboard.railway.com/oauth/auth',
      tokenUrl: RAILWAY_TOKEN_URL,
      scopes: ['openid', 'offline_access', 'workspace:member'],
      pkce: true,
      resourceIndicator: RAILWAY_MCP_RESOURCE,
      clientAuthMethod: 'client_secret_basic',
      refreshable: true,
      extraAuthorizationParams: { prompt: 'consent' },
    });
    // The refresh is the standard refresh_token grant (Basic client auth,
    // `resource` indicator) the host performs from the spec : no override.
    expect('refresh' in railwayPlugin).toBe(false);
  });
});

// ─── execute ─────────────────────────────────────────────────────────────────

describe('executeRailway with mockFetch', () => {
  test('forwards tools/call to mcp.railway.com with the stripped name and the Bearer', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_MCP_URL,
        headers: { 'content-type': 'text/event-stream' },
        respond: (c) => sseFrame(c, { content: [{ type: 'text', text: '[{"id":"p1"}]' }] }),
      },
    ]);
    const result = await railwayPlugin.execute(execCtx(fetch), 'railway__list-projects', {});
    expect(result).toEqual({ content: [{ type: 'text', text: '[{"id":"p1"}]' }] });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer rlwy_at');
    expect(call.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(call.json).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list-projects', arguments: {} },
    });
  });

  test('fills projectId from the single mission project when the tool takes one', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_MCP_URL,
        respond: (c) => sseFrame(c, { content: [{ type: 'text', text: 'ok' }] }),
      },
    ]);
    await railwayPlugin.execute(execCtx(fetch), 'railway__list-services', {});
    expect((fetch.calls[0]!.json as { params: { arguments: unknown } }).params.arguments).toEqual({
      projectId: PROJECT_STG,
    });
    // accept-deploy has no projectId in its schema : arguments are forwarded untouched.
    await railwayPlugin.execute(execCtx(fetch), 'railway__accept-deploy', {
      environmentId: ENV_STG,
    });
    expect((fetch.calls[1]!.json as { params: { arguments: unknown } }).params.arguments).toEqual({
      environmentId: ENV_STG,
    });
  });

  test('requires projectId when the mission touches several projects', async () => {
    const never = mockFetch([]);
    await expect(
      railwayPlugin.execute(execCtx(never, [staging, prod]), 'railway__list-services', {}),
    ).rejects.toThrow(/projectId: argument required/);
  });

  test('appends the staged-changes hint to railway-agent answers', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_MCP_URL,
        respond: (c) => sseFrame(c, { content: [{ type: 'text', text: 'Deployment triggered.' }] }),
      },
    ]);
    const result = await railwayPlugin.execute(execCtx(fetch), 'railway__railway-agent', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      message: 'deploy',
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'Deployment triggered.' },
      { type: 'text', text: RAILWAY_AGENT_HINT },
    ]);
  });

  test('surfaces upstream JSON-RPC errors and parses a bare JSON body too', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_MCP_URL,
        respond: (c) => ({
          jsonrpc: '2.0',
          id: (c.json as { id: number }).id,
          error: { code: -32602, message: 'invalid args' },
        }),
      },
    ]);
    await expect(
      railwayPlugin.execute(execCtx(fetch), 'railway__get-status', { projectId: PROJECT_STG }),
    ).rejects.toThrow(/invalid args/);
  });

  test('401 from the MCP server becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: RAILWAY_MCP_URL, status: 401, body: 'Unauthorized' }]);
    await expect(
      railwayPlugin.execute(execCtx(fetch), 'railway__whoami', {}),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 401 });
  });

  test('variable tools go to GraphQL and return the data as text', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_GRAPHQL_URL,
        respond: (c) => {
          const q = (c.json as { query: string }).query;
          if (q.includes('query variables'))
            return { data: { variables: { DATABASE_URL: 'pg://' } } };
          if (q.includes('variableUpsert')) return { data: { variableUpsert: true } };
          if (q.includes('variableCollectionUpsert'))
            return { data: { variableCollectionUpsert: true } };
          if (q.includes('variableDelete')) return { data: { variableDelete: true } };
          return { errors: [{ message: 'unexpected query' }] };
        },
      },
    ]);
    const ctx = execCtx(fetch);
    const listed = await railwayPlugin.execute(ctx, 'railway__list-variables', {
      environmentId: ENV_STG,
    });
    expect(JSON.parse((listed.content[0] as { text: string }).text)).toEqual({
      DATABASE_URL: 'pg://',
    });
    expect((fetch.calls[0]!.json as { variables: unknown }).variables).toEqual({
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      serviceId: null,
      unrendered: false,
    });

    const upserted = await railwayPlugin.execute(ctx, 'railway__upsert-variable', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      name: 'API_KEY',
      value: 'k1',
    });
    expect(JSON.parse((upserted.content[0] as { text: string }).text)).toEqual({ ok: true });
    expect((fetch.calls[1]!.json as { variables: { input: unknown } }).variables.input).toEqual({
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      name: 'API_KEY',
      value: 'k1',
    });

    await railwayPlugin.execute(ctx, 'railway__upsert-variables', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      variables: { A: '1' },
      replace: true,
    });
    expect(
      (fetch.calls[2]!.json as { variables: { input: { replace: boolean } } }).variables.input
        .replace,
    ).toBe(true);

    await railwayPlugin.execute(ctx, 'railway__delete-variable', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      name: 'OLD',
    });
    expect((fetch.calls[3]!.json as { query: string }).query).toContain('mutation variableDelete');
    for (const c of fetch.calls) expect(c.headers.authorization).toBe('Bearer rlwy_at');
  });

  test('GraphQL errors and 401 surface clearly', async () => {
    const errors = mockFetch([
      { url: RAILWAY_GRAPHQL_URL, body: { errors: [{ message: 'project not found' }] } },
    ]);
    await expect(
      railwayPlugin.execute(execCtx(errors), 'railway__list-variables', { environmentId: ENV_STG }),
    ).rejects.toThrow(/project not found/);
    const denied = mockFetch([{ url: RAILWAY_GRAPHQL_URL, status: 401, body: 'Unauthorized' }]);
    await expect(
      railwayPlugin.execute(execCtx(denied), 'railway__list-variables', { environmentId: ENV_STG }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 401 });
  });

  test('unknown tool → isError result ; wrong credential kind → CredentialKindMismatch', async () => {
    const never = mockFetch([]);
    const result = await railwayPlugin.execute(execCtx(never), 'railway__nope', {});
    expect(result.isError).toBe(true);
    await expect(
      railwayPlugin.execute(
        {
          ...execCtx(never),
          credential: { kind: 'api-key', fields: { api_key: 'k' }, metadata: {} },
        },
        'railway__whoami',
        {},
      ),
    ).rejects.toMatchObject({ name: 'CredentialKindMismatch' });
    expect(never.calls).toHaveLength(0);
  });
});

// ─── discoverResources ───────────────────────────────────────────────────────

describe('discoverRailwayResources', () => {
  const page = (
    projects: Array<{ id: string; name: string; envs: Array<[string, string]> }>,
    next: string | null,
  ) => ({
    data: {
      projects: {
        edges: projects.map((p) => ({
          node: {
            id: p.id,
            name: p.name,
            environments: { edges: p.envs.map(([id, name]) => ({ node: { id, name } })) },
          },
        })),
        pageInfo: { hasNextPage: next !== null, endCursor: next },
      },
    },
  });

  test('maps projects to resources with their environments, following the cursor', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_GRAPHQL_URL,
        respond: (c) => {
          const vars = (c.json as { variables: { after: string | null; first: number } }).variables;
          expect(vars.first).toBe(100);
          return vars.after === null
            ? page(
                [
                  {
                    id: PROJECT_STG,
                    name: 'api',
                    envs: [
                      [ENV_STG, 'staging'],
                      [ENV_PRD, 'production'],
                    ],
                  },
                ],
                'c1',
              )
            : page([{ id: PROJECT_PRD, name: 'web', envs: [] }], null);
        },
      },
    ]);
    const resources = await railwayPlugin.discoverResources(connCtx(fetch));
    expect(resources).toEqual([
      {
        provider: 'railway',
        ref: PROJECT_STG,
        displayName: 'api',
        metadata: {
          environments: [
            { id: ENV_STG, name: 'staging' },
            { id: ENV_PRD, name: 'production' },
          ],
        },
      },
      { provider: 'railway', ref: PROJECT_PRD, displayName: 'web', metadata: { environments: [] } },
    ]);
    expect(fetch.calls).toHaveLength(2);
    expect((fetch.calls[1]!.json as { variables: { after: string } }).variables.after).toBe('c1');
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer rlwy_at');
  });

  test('stops after the paging cap even when the provider keeps answering hasNextPage', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_GRAPHQL_URL,
        respond: () => page([{ id: PROJECT_STG, name: 'p', envs: [] }], 'more'),
      },
    ]);
    const resources = await railwayPlugin.discoverResources(connCtx(fetch));
    expect(fetch.calls).toHaveLength(5);
    expect(resources).toHaveLength(5);
  });

  test('401 becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: RAILWAY_GRAPHQL_URL, status: 401, body: 'Unauthorized' }]);
    await expect(railwayPlugin.discoverResources(connCtx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });
});
