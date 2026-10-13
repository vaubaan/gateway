/**
 * The execution door over HTTP, with the real GitHub plugin and a mocked
 * upstream (spec §10 "integration on an ephemeral instance"; never a real
 * provider): an MCP client — the official SDK client, as a coding agent's
 * runtime would use it — connects with the mission token, lists the tools and
 * calls one; the gateway mints an installation token from the company's App
 * key, forwards to the GitHub API and returns the provider's answer.
 *
 * Also here: the protocol edges of the door (2025-era and 2026-07-28 clients,
 * plain `curl`-style JSON-RPC), the bearer dispatch and the separation of the
 * three credentials (spec §6), the verified-token cache, the surface rate
 * limit, the catalog endpoint and "no secret in logs".
 */
import { generateKeyPairSync } from 'node:crypto';

import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { githubPlugin } from '@vaubaan/plugin-github';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { serializeSecret } from '../../../src/server/connections';
import {
  SURFACE_RATE_LIMITED_RPC_CODE,
  VERIFY_ATTEMPTS_PER_WINDOW,
  type MissionCatalog,
} from '../../../src/server/execution';
import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
} from '../../../src/server/execution/testing';
import type { ConnectionRecord } from '../../../src/server/store/types';

const INSTALLATION_ID = '4242';
const MINT_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const INSTALLATION_TOKEN = 'ghs_installation_token_never_returned';
const MODERN_REVISION = '2026-07-28';
const BRANCHES = [{ name: 'main' }, { name: 'feature/billing' }];

const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function githubRoutes() {
  return [
    {
      method: 'POST',
      url: MINT_URL,
      status: 201,
      body: {
        token: INSTALLATION_TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repositories: [{ id: 1, name: 'app', full_name: 'acme/app' }],
        permissions: { contents: 'read' },
      },
    },
    {
      method: 'GET',
      url: /^https:\/\/api\.github\.com\/repos\/acme\/app\/branches/,
      body: BRANCHES,
    },
  ];
}

interface GithubInstance extends ExecutionInstance {
  readonly upstream: MockFetch;
  readonly github: ConnectionRecord;
  readonly logs: string[];
  issueGithub(preset?: string): Promise<IssuedMission>;
}

async function githubInstance(env: Record<string, string> = {}): Promise<GithubInstance> {
  const upstream = mockFetch(githubRoutes());
  const logs: string[] = [];
  const instance = await executionInstance({
    plugins: [githubPlugin],
    env: {
      VAUBAAN_PROVIDER_GITHUB_APP_ID: '123',
      VAUBAAN_PROVIDER_GITHUB_APP_SLUG: 'acme-gateway',
      VAUBAAN_PROVIDER_GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
      VAUBAAN_PROVIDER_GITHUB_CLIENT_ID: 'Iv1.0000000000000000',
      VAUBAAN_PROVIDER_GITHUB_CLIENT_SECRET: 'github-app-client-secret-never-sent',
      VAUBAAN_LOG_LEVEL: 'debug',
      ...env,
    },
    deps: { providerFetch: upstream, logWrite: (_level, text) => logs.push(text) },
  });
  const { store } = instance.root;
  const github = await store.connections.create({
    provider: 'github',
    owner: { kind: 'user', id: instance.ada.id },
    displayName: 'acme-org',
    credential: serializeSecret({
      kind: 'app-install',
      installationId: INSTALLATION_ID,
      metadata: {},
    }),
  });
  await store.connections.replaceResources(github.id, [
    { ref: 'acme/app', displayName: 'acme/app', env: null },
    { ref: 'acme/infra', displayName: 'acme/infra', env: null },
  ]);
  return {
    ...instance,
    upstream,
    github,
    logs,
    async issueGithub(preset = 'read-only') {
      const result = await instance.root.missions.service.issue(instance.ada, {
        name: 'Read the app repository',
        connections: [
          {
            connection_id: github.id,
            resources: { scope: 'selected', resource_refs: ['acme/app'] },
            preset,
          },
        ],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
      if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
      return { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
    },
  };
}

/** An MCP client whose HTTP goes straight to the door's handler. */
async function connect(
  instance: ExecutionInstance,
  token: string,
  options: { modern?: boolean; headers?: Record<string, string> } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${TEST_PUBLIC_URL}/mcp`), {
    fetch: (input, init) => instance.root.execution.handlers.mcp(new Request(input, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...options.headers } },
  });
  const client = new Client(
    { name: 'door-test', version: '1.0.0' },
    options.modern ? { versionNegotiation: { mode: { pin: MODERN_REVISION } } } : {},
  );
  await client.connect(transport);
  return client;
}

describe('execution door over HTTP: real GitHub plugin, mocked upstream', () => {
  let instance: GithubInstance;

  beforeEach(async () => {
    instance = await githubInstance();
  });
  afterEach(async () => {
    await instance.close();
  });

  for (const era of ['2025-era', MODERN_REVISION] as const) {
    it(`an MCP client (${era}) lists the tools and calls one through the gateway`, async () => {
      const mission = await instance.issueGithub();
      const client = await connect(instance, mission.token, { modern: era === MODERN_REVISION });

      const { tools } = await client.listTools();
      expect(tools.length).toBe(githubPlugin.tools.length);
      expect(tools.every((t) => t.name.startsWith('github__'))).toBe(true);
      expect(tools.find((t) => t.name === 'github__list_branches')?.inputSchema).toMatchObject({
        type: 'object',
        required: ['owner', 'repo'],
      });

      const result = await client.callTool({
        name: 'github__list_branches',
        arguments: { owner: 'acme', repo: 'app' },
      });

      expect(result.isError ?? false).toBe(false);
      const [content] = result.content as { type: string; text: string }[];
      expect(JSON.parse(content?.text ?? 'null')).toEqual(BRANCHES);

      // The gateway minted a repository-scoped installation token and used it upstream.
      const [mint, api] = instance.upstream.calls;
      expect(mint?.url).toBe(MINT_URL);
      expect(mint?.json).toEqual({ repositories: ['app'] });
      expect(api?.headers.authorization).toMatch(new RegExp(`${INSTALLATION_TOKEN}$`));
      // …and nothing of it reached the executor.
      expect(JSON.stringify(result)).not.toContain(INSTALLATION_TOKEN);

      const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
      expect(entry).toMatchObject({
        kind: 'call',
        tool: 'github__list_branches',
        connection_id: instance.github.id,
        resource_ref: 'acme/app',
        decision: 'allowed',
      });
      await client.close();
    });
  }

  it('reuses the installation token across calls (upstream credential cache)', async () => {
    const mission = await instance.issueGithub();
    const client = await connect(instance, mission.token);
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'github__list_branches',
        arguments: { owner: 'acme', repo: 'app' },
      });
    }
    const mints = instance.upstream.calls.filter((c) => c.url === MINT_URL);
    expect(mints).toHaveLength(1);
    expect(instance.upstream.calls).toHaveLength(4);
    await client.close();
  });

  it('hands the client the whole refusal: code, fields and hint in the JSON-RPC error data', async () => {
    const mission = await instance.issueGithub('read-only');
    const client = await connect(instance, mission.token);

    const outside = await client
      .callTool({ name: 'github__list_branches', arguments: { owner: 'acme', repo: 'infra' } })
      .catch((err: unknown) => err);
    expect(outside).toBeInstanceOf(ProtocolError);
    expect((outside as ProtocolError).code).toBe(-32603);
    expect((outside as ProtocolError).data).toMatchObject({
      code: 'resource-not-in-mission',
      cited_ref: 'acme/infra',
      connection: { id: instance.github.id, name: 'acme-org' },
      allowed_resources: [{ ref: 'acme/app' }],
    });

    const write = await client
      .callTool({
        name: 'github__create_branch',
        arguments: { owner: 'acme', repo: 'app', branch: 'x', from_branch: 'main' },
      })
      .catch((err: unknown) => err);
    const data = (write as ProtocolError).data as Record<string, unknown>;
    expect(data.code).toBe('risk-not-accepted');
    expect((data.missing_risks as string[]).length).toBeGreaterThan(0);
    expect(data.executed_slices).toBeDefined();
    expect(typeof data.hint).toBe('string');
    // Refused calls never reach GitHub.
    expect(instance.upstream.calls).toHaveLength(0);
    await client.close();
  });

  it("answers the bootstrap kit's `curl … tools/list` with plain JSON", async () => {
    const mission = await instance.issueGithub();
    const { status, headers, body } = await instance.rpc(mission.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('application/json');
    expect((body.result?.tools as unknown[]).length).toBe(githubPlugin.tools.length);
  });

  it('is stateless: GET and DELETE open or close nothing', async () => {
    const mission = await instance.issueGithub();
    for (const method of ['GET', 'DELETE']) {
      const response = await instance.root.execution.handlers.mcp(
        new Request(`${TEST_PUBLIC_URL}/mcp`, {
          method,
          headers: { authorization: `Bearer ${mission.token}` },
        }),
      );
      expect(response.status).toBe(405);
    }
  });

  describe('tools/list and the catalog', () => {
    it('lists only the providers the mission holds a connection and an accepted risk for', async () => {
      const githubOnly = await instance.issueGithub();
      const depotOnly = await instance.issue({ policy: [line('depot.read')] });

      const list = async (mission: IssuedMission) => {
        const { body } = await instance.rpc(mission.token, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        });
        return (body.result?.tools as { name: string }[]).map((t) => t.name);
      };

      expect((await list(githubOnly)).every((name) => name.startsWith('github__'))).toBe(true);
      expect((await list(depotOnly)).sort()).toEqual([
        'depot__purge',
        'depot__read_item',
        'depot__whoami',
        'depot__write_item',
      ]);
    });

    it('GET /mcp/catalog: tool surface, callable set, resources with env labels, remaining budget', async () => {
      const mission = await instance.issue({
        policy: [line('depot.read', 5), line('depot[staging].write', 2)],
        spaces: ['app-staging', 'scratch'],
      });
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });
      await instance.call(mission, 'depot__read_item', { space: 'scratch' });

      const response = await instance.root.execution.handlers.catalog(
        new Request(`${TEST_PUBLIC_URL}/mcp/catalog`, {
          headers: { authorization: `Bearer ${mission.token}` },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const catalog = (await response.json()) as MissionCatalog;

      expect(catalog.mission).toMatchObject({ id: mission.mission.id, state: 'active' });
      expect(catalog.mission.period?.end).toBeTruthy();
      const { tools } = catalog;
      // The whole surface of the instance, with what this mission can call flagged.
      expect(tools.some((t) => t.provider === 'github' && !t.callable)).toBe(true);
      expect(tools.filter((t) => t.callable).map((t) => t.provider)).toEqual(
        Array(4).fill('depot'),
      );
      expect([...catalog.callable_tools].sort()).toEqual(
        tools
          .filter((t) => t.callable)
          .map((t) => t.name)
          .sort(),
      );
      expect(catalog.connections).toEqual([
        {
          id: instance.connection.id,
          provider: 'depot',
          name: 'Depot main',
          status: 'active',
          resources: [
            { ref: 'app-staging', env: 'staging', display_name: 'app-staging' },
            { ref: 'scratch', env: null, display_name: 'scratch' },
          ],
        },
      ]);
      expect(catalog.budget).toEqual([
        expect.objectContaining({ risk_id: 'depot.read', quota: 5, consumed: 2, remaining: 3 }),
        expect.objectContaining({
          risk_id: 'depot[staging].write',
          quota: 2,
          consumed: 0,
          remaining: 2,
          gate: 'auto',
        }),
      ]);
    });

    it('the catalog needs the mission token and refuses an inactive mission', async () => {
      const mission = await instance.issue({ policy: [line('depot.read')] });
      const get = (headers: Record<string, string>) =>
        instance.root.execution.handlers.catalog(
          new Request(`${TEST_PUBLIC_URL}/mcp/catalog`, { headers }),
        );
      expect((await get({})).status).toBe(401);

      await instance.root.missions.service.revoke(instance.ada, mission.mission.id);
      const refused = await get({ authorization: `Bearer ${mission.token}` });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { data: { code: 'mission-inactive', status: 'revoked' } },
      });
    });
  });

  describe('bearer dispatch — the three credentials never cross over (spec §6)', () => {
    const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    it('no bearer, a malformed one, an unknown one and a rotated one are 401, all alike', async () => {
      const mission = await instance.issueGithub();
      const rotated = await instance.root.missions.service.rotate(instance.ada, mission.mission.id);
      if (!rotated.ok) throw new Error('rotate refused');

      const missing = await instance.rpc(null, LIST);
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toContain('Bearer');
      expect(missing.body.error?.code).toBe(-32001);

      const wrongSecret = `vbn_live_${mission.prefix}_${'x'.repeat(32)}`;
      for (const bearer of ['garbage', `vbn_live_ZZZZZZZZ_${'y'.repeat(32)}`, wrongSecret]) {
        const unknown = await instance.rpc(bearer, LIST);
        expect(unknown.status).toBe(401);
        expect(unknown.body.error?.message).toBe('unknown or revoked bearer.');
      }
      // The token replaced by rotation stops authenticating at once; the new one works.
      expect((await instance.rpc(mission.token, LIST)).status).toBe(401);
      expect((await instance.rpc(rotated.token.secret, LIST)).status).toBe(200);
    });

    it('refuses a web session — as a cookie or as a bearer — with wrong-credential-kind', async () => {
      const session = await instance.root.auth.sessions.create({
        kind: 'user',
        userId: instance.ada.id,
        login: { email: instance.ada.email, groups: [] },
      });
      const expected = {
        code: 'wrong-credential-kind',
        door: 'execution',
        presented: 'human-session',
        expected: 'mission-token',
      };

      const asCookie = await instance.rpc(null, LIST, {
        cookie: `${SESSION_COOKIE}=${session.id}`,
      });
      expect(asCookie.status).toBe(403);
      expect(asCookie.body.error?.data).toMatchObject(expected);
      expect(asCookie.body.error?.data?.hint).toEqual(expect.any(String));

      const asBearer = await instance.rpc(session.id, LIST);
      expect(asBearer.status).toBe(403);
      expect(asBearer.body.error?.data).toMatchObject(expected);
    });

    it('refuses a delegated token with wrong-credential-kind, naming the door that accepts it', async () => {
      const delegated = await executionInstance({
        deps: {
          delegatedTokens: {
            resolve: async (bearer) =>
              bearer === 'delegated-access-token'
                ? {
                    delegation_id: 'del-1',
                    user_id: 'user-1',
                    client_id: 'claude-code',
                    scopes: ['mgmt:missions'],
                    expires_at: new Date(Date.now() + 60_000).toISOString(),
                  }
                : null,
          },
        },
      });
      try {
        const { status, body } = await delegated.rpc('delegated-access-token', LIST);
        expect(status).toBe(403);
        expect(body.error?.data).toMatchObject({
          code: 'wrong-credential-kind',
          door: 'execution',
          presented: 'delegated-token',
          expected: 'mission-token',
        });
        expect(body.error?.data?.hint).toContain('management');
      } finally {
        await delegated.close();
      }
    });

    it('refuses a browser origin other than the instance', async () => {
      const mission = await instance.issueGithub();
      const foreign = await instance.rpc(mission.token, LIST, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      const own = await instance.rpc(mission.token, LIST, { origin: TEST_PUBLIC_URL });
      expect(own.status).toBe(200);
    });
  });

  describe('verified-token cache and rate limits', () => {
    const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    it('verifies the argon2 hash once per token, yet sees a revocation on the next call', async () => {
      const mission = await instance.issueGithub();
      const verify = vi.spyOn(instance.root.missions.service, 'verifyToken');

      const burst = await Promise.all(
        Array.from({ length: 8 }, () => instance.rpc(mission.token, LIST)),
      );
      expect(burst.every((r) => r.status === 200)).toBe(true);
      for (let i = 0; i < 5; i++)
        expect((await instance.rpc(mission.token, LIST)).status).toBe(200);
      expect(verify).toHaveBeenCalledTimes(1);

      await instance.root.missions.service.revoke(instance.ada, mission.mission.id);
      const after = await instance.rpc(mission.token, LIST);
      expect(after.body.error?.data).toMatchObject({ code: 'mission-inactive', status: 'revoked' });
      expect(verify).toHaveBeenCalledTimes(1);
    });

    it('throttles hash verifications of wrong secrets on a real prefix', async () => {
      const mission = await instance.issueGithub();
      const statuses: number[] = [];
      for (let i = 0; i <= VERIFY_ATTEMPTS_PER_WINDOW; i++) {
        const wrong = `vbn_live_${mission.prefix}_${String(i).padStart(32, 'a')}`;
        statuses.push((await instance.rpc(wrong, LIST)).status);
      }
      expect(statuses.slice(0, VERIFY_ATTEMPTS_PER_WINDOW).every((s) => s === 401)).toBe(true);
      expect(statuses[VERIFY_ATTEMPTS_PER_WINDOW]).toBe(429);
    }, 60_000);

    it('applies the surface rate limit per mission, not per agent', async () => {
      const limited = await githubInstance({ VAUBAAN_MCP_RATE_LIMIT_PER_MINUTE: '3' });
      try {
        const one = await limited.issue({ policy: [line('depot.read')], name: 'one' });
        const two = await limited.issue({ policy: [line('depot.read')], name: 'two' });
        for (const agent of ['a', 'b', 'c']) {
          const ok = await limited.rpc(one.token, LIST, { 'x-vaubaan-agent': agent });
          expect(ok.status).toBe(200);
        }
        const over = await limited.rpc(one.token, LIST, { 'x-vaubaan-agent': 'd' });
        expect(over.status).toBe(429);
        expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(over.body.error).toMatchObject({
          code: SURFACE_RATE_LIMITED_RPC_CODE,
          data: { retry_after_seconds: expect.any(Number) as number },
        });
        // Another mission has its own window.
        expect((await limited.rpc(two.token, LIST)).status).toBe(200);
      } finally {
        await limited.close();
      }
    });
  });

  it('writes no secret and no argument to the logs: token by prefix, arguments by hash', async () => {
    const mission = await instance.issueGithub();
    await instance.rpc(mission.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'github__get_file_contents',
        arguments: { owner: 'acme', repo: 'app', path: 'secrets/prod.env', ref: 'main' },
      },
    });
    await instance.call(mission, 'github__list_branches', { owner: 'acme', repo: 'app' });

    const all = instance.logs.join('');
    const secret = mission.token.slice(mission.token.lastIndexOf('_') + 1);
    expect(all).toContain('tools/call');
    expect(all).toContain(mission.prefix);
    expect(all).not.toContain(secret);
    expect(all).not.toContain(INSTALLATION_TOKEN);
    expect(all).not.toContain('secrets/prod.env');
    expect(all).not.toContain('BEGIN PRIVATE KEY');
    expect(all).not.toContain('github-app-client-secret-never-sent');
    expect(all).toMatch(/"arguments_hash":"[0-9a-f]{64}"/);
  });
});
