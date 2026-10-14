/**
 * The token way of connecting Railway (`token.ts`) against `mockFetch` : the
 * check at paste, discovery across the account's workspaces, a variable tool
 * with the account token, and the MCP tools refused. No network.
 */
import { describe, expect, test } from 'vitest';

import {
  UpstreamAuthError,
  credentialSpecFor,
  unavailableToolReason,
  type ConnectionContext,
} from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch, type RecordedCall } from '@vaubaan/plugin-sdk/testing';

import railwayPlugin, {
  RAILWAY_GRAPHQL_URL,
  railwayTokenCredential,
  verifyRailwayToken,
} from '../../src/index.ts';
import { CUSTOM_TOOL_NAMES } from '../../src/custom-tools.ts';

const TOKEN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PERSONAL = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-000000000002';
const ENV = '00000000-0000-4000-8000-0000000000e1';

function ctx(fetch: MockFetch): ConnectionContext {
  return {
    credential: { kind: 'api-key', fields: { api_token: TOKEN }, metadata: {} },
    appConfig: {},
    fetch,
  };
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

describe('railway token — the declaration', () => {
  test('OAuth app first, then an account token that runs the variable tools only', () => {
    expect(railwayPlugin.credential.kind).toBe('oauth2');
    expect(credentialSpecFor(railwayPlugin, 'api-key')).toBe(railwayTokenCredential);
    for (const tool of railwayPlugin.tools) {
      const reason = unavailableToolReason(railwayPlugin, 'api-key', tool.name);
      if (CUSTOM_TOOL_NAMES.has(tool.name)) expect(reason).toBeNull();
      else expect(reason).toMatch(/^needs the Railway OAuth app/);
      expect(unavailableToolReason(railwayPlugin, 'oauth2', tool.name)).toBeNull();
    }
  });
});

describe('railway token — verify at paste', () => {
  test('me names the account', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_GRAPHQL_URL,
        body: { data: { me: { name: 'Ops', email: 'ops@acme.example' } } },
      },
    ]);
    expect(await verifyRailwayToken(ctx(fetch))).toEqual({
      account: 'ops@acme.example',
      expiresAt: null,
    });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('a token without an account (a GraphQL error) or a 401 is rejected', async () => {
    const noMe = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_GRAPHQL_URL,
        body: { data: { me: null }, errors: [{ message: 'Not Authorized' }] },
      },
    ]);
    await expect(verifyRailwayToken(ctx(noMe))).rejects.toBeInstanceOf(UpstreamAuthError);
    const denied = mockFetch([{ method: 'POST', url: RAILWAY_GRAPHQL_URL, status: 401, body: '' }]);
    await expect(verifyRailwayToken(ctx(denied))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});

describe('railway token — discovery and execution', () => {
  test('personal projects, then each workspace, without duplicates', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RAILWAY_GRAPHQL_URL,
        respond: (call) => {
          const query = queryOf(call);
          if (query.includes('vaubaanWorkspaces')) {
            return { data: { me: { workspaces: [{ id: 'ws-1', name: 'Acme' }] } } };
          }
          if (query.includes('vaubaanWorkspaceProjects')) {
            expect(
              (call.json as { variables: { workspaceId: string } }).variables.workspaceId,
            ).toBe('ws-1');
            return {
              data: {
                projects: {
                  edges: [
                    ...projects(PERSONAL, 'mine').data.projects.edges,
                    ...projects(TEAM, 'team').data.projects.edges,
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            };
          }
          return projects(PERSONAL, 'mine');
        },
      },
    ]);
    const resources = await railwayPlugin.discoverResources(ctx(fetch));
    expect(resources.map((r) => r.ref)).toEqual([PERSONAL, TEAM]);
    for (const call of fetch.calls) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('an MCP tool on a token connection is declined before any request', async () => {
    const fetch = mockFetch([]);
    const result = await railwayPlugin.execute(
      { ...ctx(fetch), resources: [] },
      'railway__whoami',
      {},
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/needs the Railway OAuth app/);
    expect(fetch.calls).toHaveLength(0);
  });
});
