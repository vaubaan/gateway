/**
 * Mandatory test suite of the Railway plugin : the SDK kit, the
 * classifier on `Resource[]`, the credential spec, `execute`
 * and `discoverResources` against `mockFetch`. No network, ever.
 *
 * The per-tool slice shapes of the classifier are in `classify.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import {
  UpstreamProtocolError,
  parseSlice,
  serializeSlice,
  type AccountContext,
  type ExecuteContext,
  type ApiKeySecret,
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
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import {
  RAILWAY_AGENT_HINT,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_URL,
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
  metadata: {
    services: [{ id: SERVICE, name: 'api' }],
    environments: [{ id: ENV_STG, name: 'staging' }],
  },
};
const prod: Resource = {
  provider: 'railway',
  ref: PROJECT_PRD,
  env: 'prod',
  displayName: 'api (prod)',
  metadata: {
    services: [{ id: SERVICE, name: 'api' }],
    environments: [{ id: ENV_PRD, name: 'production' }],
  },
};
/** Discovered, but the owner has not labelled it yet. */
const unlabelled: Resource = {
  provider: 'railway',
  ref: PROJECT_STG,
  displayName: 'api',
  metadata: {
    services: [{ id: SERVICE, name: 'api' }],
    environments: [{ id: ENV_STG, name: 'staging' }],
  },
};
/** A project resource whose environments discovery never stored. */
const undiscovered: Resource = {
  provider: 'railway',
  ref: PROJECT_STG,
  env: 'staging',
  displayName: 'api',
};
const foreign: Resource = { provider: 'vercel', ref: 'prj_1', displayName: 'other' };

const secret = (over: Partial<ApiKeySecret> = {}): ApiKeySecret => ({
  kind: 'api-key',
  fields: { api_token: 'rlwy_at' },
  metadata: {},
  ...over,
});

const connCtx = (
  fetch: typeof globalThis.fetch,
  over: Partial<AccountContext> = {},
): AccountContext => ({
  credential: secret(),
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
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(railwayPlugin);
    assertNoWildcard(railwayPlugin);
  });

  // A deploy spends compute (moderate cost) : row 2 since 2026-11-13, it asks
  // first at Careful on every environment and runs freely from Trusting on staging.
  test('at Careful, a deploy asks first on staging and on prod ; no agent', () => {
    const lines = policyFromMacroActions(
      railwayPlugin,
      { watch: 'careful', deploy: 'careful', configure: 'careful' },
      { envs: ['staging', 'prod'] },
    );
    const gate = (id: string) => lines.find((e) => e.risk_id === id)?.gate;
    expect(gate('railway[prod].deploy')).toBe('approval');
    expect(gate('railway[staging].deploy')).toBe('approval');
    const trusting = policyFromMacroActions(
      railwayPlugin,
      { deploy: 'trusting' },
      { envs: ['staging'] },
    );
    expect(trusting.find((e) => e.risk_id === 'railway[staging].deploy')?.gate).toBe('auto');
    expect(lines.some((e) => e.risk_id === 'railway.agent-action')).toBe(false);
    for (const e of lines) expect(e.quota).toBeGreaterThan(0);
  });

  // One table for the catalog coverage and for the identifier proof : the plugin's own
  // `examples` (`src/examples.ts`), each sample with its resources.
  const SAMPLES: ToolSamples = railwayPlugin.examples;

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(railwayPlugin);
    // Paths only : this model's cardinalities count instances, not how a slice names them.
    assertSlicesOnDataModel(railwayPlugin, SAMPLES, { resources: [staging], cardinalities: false });
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

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(railwayPlugin, SAMPLES, {
      resources: [staging],
      context: (fetch, resources) => execCtx(fetch, resources),
      pathIdentifiers: {
        none: 'every call is one JSON-RPC POST to the MCP endpoint: identifiers travel in its body',
      },
    });
    expect(report.toolsChecked).toBe(14);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });
});

// ─── Classifier on Resource[] ────────────────────────────────────────────────

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

  test('accept-deploy with a single mission project still checks the environment belongs to it', () => {
    expect(slices('railway__accept-deploy', { environmentId: ENV_STG })).toEqual([
      `railway.project[${PROJECT_STG}].environment[staging].service[*].deployment.W`,
    ]);
    // ENV_PRD is an environment of a project the mission does not select.
    expect(denied('railway__accept-deploy', { environmentId: ENV_PRD })).toBe(
      `environmentId: not an environment of railway project '${PROJECT_STG}'.`,
    );
    expect(denied('railway__accept-deploy', {})).toBe(
      'environmentId: required, it is the only argument naming the target.',
    );
    expect(denied('railway__accept-deploy', { environmentId: 42 })).toBe(
      'environmentId: malformed ref.',
    );
  });

  test('an explicit projectId does not exempt environmentId from the check', () => {
    const crossed = { projectId: PROJECT_STG, environmentId: ENV_PRD };
    const refusal = `environmentId: not an environment of railway project '${PROJECT_STG}'.`;
    expect(denied('railway__redeploy', { ...crossed, serviceId: SERVICE })).toBe(refusal);
    expect(denied('railway__list-variables', crossed)).toBe(refusal);
    expect(denied('railway__railway-agent', { ...crossed, message: 'hi' })).toBe(refusal);
    // Both projects in the mission : the pair must still agree.
    expect(denied('railway__list-variables', crossed, [staging, prod])).toBe(refusal);
  });

  test('a project without discovered environments accepts no environmentId', () => {
    expect(denied('railway__accept-deploy', { environmentId: ENV_STG }, [undiscovered])).toMatch(
      /^environmentId: the environments of railway project '.+' are unknown/,
    );
    expect(denied('railway__list-variables', { environmentId: ENV_STG }, [undiscovered])).toMatch(
      /^environmentId: the environments of railway project '.+' are unknown/,
    );
    // Nothing to bind without an environmentId.
    expect(slices('railway__list-services', {}, [undiscovered])).toEqual([
      `railway.project[${PROJECT_STG}].environment[*].service[*].R`,
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
    expect(environmentsOf(undiscovered)).toEqual([]);
    expect(environmentsOf({ ...undiscovered, metadata: { environments: 'nope' } })).toEqual([]);
    expect(
      environmentsOf({
        ...undiscovered,
        metadata: {
          services: [{ id: SERVICE, name: 'api' }],
          environments: [{ id: 1 }, { id: 'e', name: 'n' }],
        },
      }),
    ).toEqual([{ id: 'e', name: 'n' }]);
  });
});

// ─── Credential spec ─────────────────────────────────────────────────────────

describe('railway credential', () => {
  test('a workspace or account token pasted by hand, the one way of connecting', () => {
    expect(railwayPlugin.credential).toMatchObject({ kind: 'api-key', label: 'workspace token' });
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
    expect(
      await refusalText(
        railwayPlugin.execute(execCtx(never, [staging, prod]), 'railway__list-services', {}),
      ),
    ).toMatch(/projectId: argument required/);
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

  test('a JSON-RPC error frame, in a bare JSON body too, is an UpstreamProtocolError', async () => {
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
    const run = railwayPlugin.execute(execCtx(fetch), 'railway__get-status', {
      projectId: PROJECT_STG,
    });
    await expect(run).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(run).rejects.toThrow(/-32602: invalid args/);
  });

  test('an MCP answer that is not a tool result is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([{ url: RAILWAY_MCP_URL, respond: (c) => sseFrame(c, { rows: [] }) }]);
    await expect(
      railwayPlugin.execute(execCtx(fetch), 'railway__whoami', {}),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('the MCP server is stateless : a 400 is thrown as it is, no session is opened', async () => {
    const fetch = mockFetch([{ url: RAILWAY_MCP_URL, status: 400, body: 'bad request' }]);
    await expect(
      railwayPlugin.execute(execCtx(fetch), 'railway__whoami', {}),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 400 });
    expect(fetch.calls).toHaveLength(1);
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

  test('an SSE-framed JSON-RPC error surfaces too', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_MCP_URL,
        headers: { 'content-type': 'text/event-stream' },
        respond: (c) =>
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: (c.json as { id: number }).id,
            error: { code: -32602, message: 'invalid args' },
          })}\n\n`,
      },
    ]);
    await expect(
      railwayPlugin.execute(execCtx(fetch), 'railway__get-status', { projectId: PROJECT_STG }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('bulk upsert and delete send the whole input, undefined fields stripped', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_GRAPHQL_URL,
        respond: (c) =>
          (c.json as { query: string }).query.includes('variableCollectionUpsert')
            ? { data: { variableCollectionUpsert: true } }
            : { data: { variableDelete: true } },
      },
    ]);
    const ctx = execCtx(fetch);
    await railwayPlugin.execute(ctx, 'railway__upsert-variables', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      serviceId: SERVICE,
      variables: { A: '1', B: '2' },
      replace: true,
    });
    const bulk = fetch.calls[0]!.json as { query: string; variables: { input: unknown } };
    expect(bulk.query).toContain('mutation variableCollectionUpsert');
    expect(bulk.variables.input).toEqual({
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      serviceId: SERVICE,
      variables: { A: '1', B: '2' },
      replace: true,
    });

    await railwayPlugin.execute(ctx, 'railway__delete-variable', {
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      name: 'OLD_KEY',
    });
    const del = fetch.calls[1]!.json as { query: string; variables: { input: unknown } };
    expect(del.query).toContain('mutation variableDelete');
    expect(del.variables.input).toEqual({
      projectId: PROJECT_STG,
      environmentId: ENV_STG,
      name: 'OLD_KEY',
    });
  });

  test('GraphQL errors are an UpstreamProtocolError naming the operation ; a 401 an UpstreamAuthError', async () => {
    const errors = mockFetch([
      { url: RAILWAY_GRAPHQL_URL, body: { errors: [{ message: 'project not found' }] } },
    ]);
    const failed = railwayPlugin.execute(execCtx(errors), 'railway__list-variables', {
      environmentId: ENV_STG,
    });
    await expect(failed).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(failed).rejects.toThrow('Railway GraphQL variables: project not found');
    const denied = mockFetch([{ url: RAILWAY_GRAPHQL_URL, status: 401, body: 'Unauthorized' }]);
    await expect(
      railwayPlugin.execute(execCtx(denied), 'railway__list-variables', { environmentId: ENV_STG }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 401 });
  });

  test('a GraphQL answer without data, or of the wrong shape, is an UpstreamProtocolError', async () => {
    const list = { environmentId: ENV_STG };
    const write = { environmentId: ENV_STG, name: 'API_KEY', value: 'k1' };
    for (const [tool, args, body] of [
      ['railway__list-variables', list, { data: null }],
      ['railway__list-variables', list, { data: { variables: 'DATABASE_URL=pg://' } }],
      ['railway__upsert-variable', write, { data: { variableUpsert: 'yes' } }],
      ['railway__list-variables', list, 'not json'],
    ] as const) {
      const fetch = mockFetch([{ url: RAILWAY_GRAPHQL_URL, body }]);
      await expect(
        railwayPlugin.execute(execCtx(fetch), tool, args),
        `${tool} ${JSON.stringify(body)}`,
      ).rejects.toBeInstanceOf(UpstreamProtocolError);
    }
  });

  test('unknown tool → isError result ; wrong credential kind → CredentialKindMismatch', async () => {
    const never = mockFetch([]);
    expect(await refusalText(railwayPlugin.execute(execCtx(never), 'railway__nope', {}))).toBe(
      "unknown tool 'railway__nope'",
    );
    await expect(
      railwayPlugin.execute(
        {
          ...execCtx(never),
          // api-key is the pasted account token, a declared way; an SSH key is not.
          credential: {
            kind: 'ssh-key',
            privateKeyPem: 'k',
            publicKey: 'p',
            fields: {},
            metadata: {},
          },
        },
        'railway__list-variables',
        { projectId: PROJECT_STG, environmentId: ENV_STG },
      ),
    ).rejects.toMatchObject({ name: 'CredentialKindMismatch' });
    expect(never.calls).toHaveLength(0);
  });
});

// ─── discoverResources ───────────────────────────────────────────────────────

describe('discoverRailwayResources', () => {
  const page = (
    projects: Array<{
      id: string;
      name: string;
      envs: Array<[string, string]>;
      services?: Array<[string, string]>;
    }>,
    next: string | null,
  ) => ({
    data: {
      projects: {
        edges: projects.map((p) => ({
          node: {
            id: p.id,
            name: p.name,
            environments: { edges: p.envs.map(([id, name]) => ({ node: { id, name } })) },
            // The second project answers without the account at all : read as "no service".
            ...(p.services
              ? { services: { edges: p.services.map(([id, name]) => ({ node: { id, name } })) } }
              : {}),
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
          const sent = c.json as {
            query: string;
            variables: { after: string | null; first: number };
          };
          // A token account asks the account's workspaces after its own projects.
          if (sent.query.includes('vaubaanWorkspaces')) return { data: { me: { workspaces: [] } } };
          const vars = sent.variables;
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
                    services: [[SERVICE, 'api']],
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
          services: [{ id: SERVICE, name: 'api' }],
        },
      },
      {
        provider: 'railway',
        ref: PROJECT_PRD,
        displayName: 'web',
        metadata: { environments: [], services: [] },
      },
    ]);
    // The services are asked for with the projects : what a `serviceId` is bound to.
    expect((fetch.calls[0]!.json as { query: string }).query).toMatch(
      /services\s*\{\s*edges\s*\{\s*node\s*\{\s*id\s+name/,
    );
    // Two pages of projects, then the account's workspaces.
    expect(fetch.calls).toHaveLength(3);
    expect((fetch.calls[1]!.json as { variables: { after: string } }).variables.after).toBe('c1');
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer rlwy_at');
  });

  test('stops after the paging cap even when the provider keeps answering hasNextPage', async () => {
    const fetch = mockFetch([
      {
        url: RAILWAY_GRAPHQL_URL,
        respond: (c) =>
          (c.json as { query: string }).query.includes('vaubaanWorkspaces')
            ? { data: { me: { workspaces: [] } } }
            : page([{ id: PROJECT_STG, name: 'p', envs: [] }], 'more'),
      },
    ]);
    const resources = await railwayPlugin.discoverResources(connCtx(fetch));
    // Five pages of projects, then the account's workspaces (none).
    expect(fetch.calls).toHaveLength(6);
    expect(resources).toHaveLength(5);
  });

  test('401 becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: RAILWAY_GRAPHQL_URL, status: 401, body: 'Unauthorized' }]);
    await expect(railwayPlugin.discoverResources(connCtx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });

  test('a page of the wrong shape, or a project id outside the grammar, is an UpstreamProtocolError', async () => {
    for (const body of [
      { data: { projects: { edges: [{ node: { id: PROJECT_STG } }] } } },
      { data: { projects: { edges: 'none' } } },
      page([{ id: 'not/an/id', name: 'p', envs: [] }], null),
    ]) {
      const fetch = mockFetch([{ url: RAILWAY_GRAPHQL_URL, body }]);
      await expect(
        railwayPlugin.discoverResources(connCtx(fetch)),
        JSON.stringify(body),
      ).rejects.toBeInstanceOf(UpstreamProtocolError);
    }
  });
});
