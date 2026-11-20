/**
 * The token of Railway (`credential.ts`) against `mockFetch` : the check at
 * paste for a workspace and an account token, discovery with each, an
 * MCP-server tool, and what an MCP refusal of the token turns into. No network.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, type AccountContext, type CredentialSecret } from '@vaubaan/plugin-sdk';
import {
  guideText,
  type MockFetch,
  mockFetch,
  type MockRoute,
  type RecordedCall,
} from '@vaubaan/plugin-sdk/testing';

import railwayPlugin, {
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_URL,
  probeRailwayToken,
  railwayCredential,
  verifyRailwayToken,
} from '../../src/index.ts';

const TOKEN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PERSONAL = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-000000000002';
const ENV = '00000000-0000-4000-8000-0000000000e1';

const PASTED: CredentialSecret = { kind: 'api-key', fields: { api_token: TOKEN }, metadata: {} };

function ctx(fetch: MockFetch, credential: CredentialSecret = PASTED): AccountContext {
  return { credential, fetch };
}

const projects = (id: string, name: string) => ({
  data: {
    projects: {
      edges: [
        {
          node: {
            id,
            name,
            environments: { edges: [{ node: { id: ENV, name: 'production' } }] },
            services: { edges: [] },
          },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
});

function queryOf(call: RecordedCall): string {
  return (call.json as { query: string }).query;
}

/** A GraphQL answer per operation name. */
type GraphqlScript = Readonly<Record<string, unknown>>;

const NOT_AUTHORIZED = { data: null, errors: [{ message: 'Not Authorized' }] };

/** Railway's API as a workspace token sees it : no `me`, its workspace's projects. */
const WORKSPACE_TOKEN_API: GraphqlScript = {
  vaubaanTokenOwner: NOT_AUTHORIZED,
  vaubaanWorkspaces: NOT_AUTHORIZED,
  vaubaanTokenReach: { data: { projects: { edges: [{ node: { id: TEAM, name: 'gateway' } }] } } },
  vaubaanTokenWorkspace: {
    data: { projects: { edges: [{ node: { workspace: { name: 'vaubaan' } } }] } },
  },
  vaubaanProjects: projects(TEAM, 'gateway'),
};

/** Railway's API as an account token sees it. */
const ACCOUNT_TOKEN_API: GraphqlScript = {
  vaubaanTokenOwner: { data: { me: { name: 'Ops', email: 'ops@acme.example' } } },
  vaubaanWorkspaces: { data: { me: { workspaces: [{ id: 'ws-1', name: 'Acme' }] } } },
  vaubaanProjects: projects(PERSONAL, 'mine'),
};

/** Railway's API refusing the token whatever is asked. */
const DEAD_TOKEN_API: GraphqlScript = {
  vaubaanTokenOwner: NOT_AUTHORIZED,
  vaubaanTokenReach: NOT_AUTHORIZED,
};

function graphqlRoute(script: GraphqlScript): MockRoute {
  return {
    method: 'POST',
    url: RAILWAY_GRAPHQL_URL,
    respond: (call) => {
      const name = /query (\w+)/.exec(queryOf(call))?.[1] ?? '';
      if (!(name in script)) throw new Error(`unexpected GraphQL query ${name}`);
      return script[name];
    },
  };
}

/** The MCP server answering `tools/call` with one text, as an SSE frame. */
function mcpRoute(text: string): MockRoute {
  return {
    method: 'POST',
    url: RAILWAY_MCP_URL,
    headers: { 'content-type': 'text/event-stream' },
    respond: (call) => {
      const id = (call.json as { id: number }).id;
      const frame = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      return `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
    },
  };
}

const mcpRefuses = (status: number): MockRoute => ({
  method: 'POST',
  url: RAILWAY_MCP_URL,
  status,
  body: 'refused',
});

/** Runs a tool and returns what it threw. */
async function failureOf(
  fetch: MockFetch,
  tool: string,
  credential: CredentialSecret = PASTED,
): Promise<UpstreamAuthError> {
  const failure = await railwayPlugin
    .execute({ ...ctx(fetch, credential), resources: [] }, tool, {})
    .then(() => null)
    .catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(UpstreamAuthError);
  return failure as UpstreamAuthError;
}

describe('railway token — the declaration', () => {
  test('a workspace token (recommended) is the one way of connecting, and runs every tool', () => {
    expect(railwayPlugin.credential).toBe(railwayCredential);
    expect(railwayCredential.label).toBe('workspace token');
  });

  test('the guide offers the account token second and says why not a project token', () => {
    const steps = guideText(railwayCredential.guide);
    expect(steps.indexOf('workspace token')).toBeGreaterThan(-1);
    expect(steps.indexOf('workspace token')).toBeLessThan(steps.indexOf('account token'));
    expect(steps).toMatch(/project token is not accepted: it reaches one environment/);
  });
});

describe('railway token — verify at paste', () => {
  test('a workspace token: no me, its projects answer, named by its workspace', async () => {
    const fetch = mockFetch([graphqlRoute(WORKSPACE_TOKEN_API)]);
    expect(await verifyRailwayToken(ctx(fetch))).toEqual({
      account: 'the vaubaan workspace',
      expiresAt: null,
    });
    for (const call of fetch.calls) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('a workspace token whose workspace name is not exposed is named by its projects', async () => {
    const fetch = mockFetch([
      graphqlRoute({ ...WORKSPACE_TOKEN_API, vaubaanTokenWorkspace: NOT_AUTHORIZED }),
    ]);
    expect(await probeRailwayToken({ fetch }, TOKEN)).toEqual({
      kind: 'workspace',
      account: 'the workspace of gateway',
    });
  });

  test('an account token: me names it, nothing else is asked', async () => {
    const fetch = mockFetch([graphqlRoute(ACCOUNT_TOKEN_API)]);
    expect(await verifyRailwayToken(ctx(fetch))).toEqual({
      account: 'ops@acme.example',
      expiresAt: null,
    });
    expect(fetch.calls).toHaveLength(1);
  });

  test('a token refused either way, by GraphQL errors or a 401, is rejected', async () => {
    const refused = mockFetch([graphqlRoute(DEAD_TOKEN_API)]);
    await expect(verifyRailwayToken(ctx(refused))).rejects.toThrow(
      /neither as a workspace token nor as an account token/,
    );
    const denied = mockFetch([{ method: 'POST', url: RAILWAY_GRAPHQL_URL, status: 401, body: '' }]);
    await expect(verifyRailwayToken(ctx(denied))).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('Railway not answering is not a rejection', async () => {
    const down = mockFetch([{ method: 'POST', url: RAILWAY_GRAPHQL_URL, status: 502, body: '' }]);
    const failure = await verifyRailwayToken(ctx(down)).catch((err: unknown) => err);
    expect(failure).toMatchObject({ name: 'UpstreamHttpError', status: 502 });
    expect(failure).not.toBeInstanceOf(UpstreamAuthError);
  });
});

describe('railway token — discovery', () => {
  test('an account token: personal projects, then each workspace, without duplicates', async () => {
    const fetch = mockFetch([
      graphqlRoute({
        ...ACCOUNT_TOKEN_API,
        vaubaanWorkspaceProjects: {
          data: {
            projects: {
              edges: [
                ...projects(PERSONAL, 'mine').data.projects.edges,
                ...projects(TEAM, 'team').data.projects.edges,
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ]);
    const resources = await railwayPlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual([PERSONAL, TEAM]);
    const perWorkspace = fetch.calls.find((c) => queryOf(c).includes('vaubaanWorkspaceProjects'));
    expect((perWorkspace?.json as { variables: { workspaceId: string } }).variables).toMatchObject({
      workspaceId: 'ws-1',
    });
  });

  test('a workspace token: its projects, and the refused me ends the list', async () => {
    const fetch = mockFetch([graphqlRoute(WORKSPACE_TOKEN_API)]);
    const resources = await railwayPlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual([TEAM]);
    for (const call of fetch.calls) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('railway token — execution', () => {
  test('an MCP-server tool runs with the token as Bearer on mcp.railway.com', async () => {
    const fetch = mockFetch([mcpRoute('vaubaan: me')]);
    const result = await railwayPlugin.execute(
      { ...ctx(fetch), resources: [] },
      'railway__whoami',
      {},
    );
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('vaubaan: me');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe(RAILWAY_MCP_URL);
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetch.calls[0]!.headers['user-agent']).toBe('vaubaan-gateway');
    expect((fetch.calls[0]!.json as { params: { name: string } }).params.name).toBe('whoami');
  });

  test('a token the MCP server and the API both refuse is a rejected credential (401)', async () => {
    const fetch = mockFetch([mcpRefuses(401), graphqlRoute(DEAD_TOKEN_API)]);
    const failure = await failureOf(fetch, 'railway__whoami');
    expect(failure.upstreamStatus).toBe(401);
    expect(failure.message).toMatch(/deleted or has expired.*new workspace token/);
  });

  test('an account token the MCP server refuses but the API accepts: 403, naming the kind', async () => {
    const fetch = mockFetch([mcpRefuses(401), graphqlRoute(ACCOUNT_TOKEN_API)]);
    const failure = await failureOf(fetch, 'railway__whoami');
    expect(failure.upstreamStatus).toBe(403);
    expect(failure.message).toMatch(
      /refused this account token \(HTTP 401\).*reconnect the account with a workspace token/,
    );
  });

  test('a workspace token the MCP server refuses but the API accepts: 403, naming the kind', async () => {
    const fetch = mockFetch([mcpRefuses(403), graphqlRoute(WORKSPACE_TOKEN_API)]);
    const failure = await failureOf(fetch, 'railway__whoami');
    expect(failure.upstreamStatus).toBe(403);
    expect(failure.message).toMatch(/refused this workspace token \(HTTP 403\)/);
  });

  test('an MCP refusal whose probe cannot reach Railway stays as it was', async () => {
    const fetch = mockFetch([
      mcpRefuses(401),
      { method: 'POST', url: RAILWAY_GRAPHQL_URL, status: 502, body: '' },
    ]);
    const failure = await failureOf(fetch, 'railway__whoami');
    expect(failure.upstreamStatus).toBe(401);
    expect(failure.message).toMatch(/^Railway MCP server, tools\/call failed with HTTP 401/);
  });
});
