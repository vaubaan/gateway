/**
 * The execution door over HTTP, with the real GitHub plugin and a mocked
 * upstream (spec §10 "integration on an ephemeral instance"; never a real
 * service): an MCP client — the official SDK client, as a coding agent's
 * runtime would use it — connects with the mission token, lists the tools and
 * calls one; the gateway sends the account's token to the GitHub API and
 * returns the service's answer.
 *
 * Also here: the protocol edges of the door (2025-era and 2026-07-28 clients,
 * plain `curl`-style JSON-RPC), the bearer dispatch and the separation of the
 * three credentials (spec §6), token verification (the sha256 digest), the
 * surface rate limit, the catalog endpoint and "no secret in logs".
 */

import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { githubPlugin } from '@vaubaan/plugin-github';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import { jsonBytes } from '@vaubaan/gateway-core';
import { digestApiKey } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { serializeSecret } from '../../../src/server/accounts';
import { SURFACE_RATE_LIMITED_RPC_CODE, type MissionCatalog } from '../../../src/server/execution';
import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';
import type { AccountRecord } from '../../../src/server/store/types';

const INSTALLATION_ID = '4242';
const MINT_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
const ACCOUNT_TOKEN = 'ghs_installation_token_never_returned';
const MODERN_REVISION = '2026-07-28';
const BRANCHES = [{ name: 'main' }, { name: 'feature/billing' }];

function githubRoutes() {
  return [
    {
      method: 'POST',
      url: MINT_URL,
      status: 201,
      body: {
        token: ACCOUNT_TOKEN,
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
  readonly github: AccountRecord;
  readonly logs: string[];
  issueGithub(trustLevels?: Readonly<Record<string, string>>): Promise<IssuedMission>;
}

async function githubInstance(env: Record<string, string> = {}): Promise<GithubInstance> {
  const upstream = mockFetch(githubRoutes());
  const logs: string[] = [];
  const instance = await executionInstance({
    plugins: [githubPlugin],
    env: {
      VAUBAAN_LOG_LEVEL: 'debug',
      ...env,
    },
    deps: { serviceFetch: upstream, logWrite: (_level, text) => logs.push(text) },
  });
  const { store } = instance.root;
  const github = await store.accounts.create({
    service: 'github',
    owner: { kind: 'user', id: instance.ada.id },
    displayName: 'acme-org',
    credential: serializeSecret({
      kind: 'api-key',
      fields: { token: ACCOUNT_TOKEN },
      metadata: {},
    }),
  });
  await store.accounts.syncDiscoveredResources(github.id, [
    { ref: 'acme/app', displayName: 'acme/app', env: null },
    { ref: 'acme/infra', displayName: 'acme/infra', env: null },
  ]);
  return {
    ...instance,
    upstream,
    github,
    logs,
    async issueGithub(trustLevels = { read: 'careful' }) {
      const result = await instance.root.missions.service.issue(instance.ada, {
        name: 'Read the app repository',
        accounts: [
          {
            account_id: github.id,
            resources: { scope: 'selected', resource_refs: ['acme/app'] },
            trust_levels: trustLevels,
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
      expect(tools.length).toBe(githubPlugin.tools.length + 1);
      expect(
        tools.every(
          (t) => t.name.startsWith('github__') || t.name === 'vaubaan__request_permission',
        ),
      ).toBe(true);
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

      // The gateway sent the account's token upstream…
      const [api] = instance.upstream.calls;
      expect(api?.headers.authorization).toMatch(new RegExp(`${ACCOUNT_TOKEN}$`));
      // …and nothing of it reached the executor.
      expect(JSON.stringify(result)).not.toContain(ACCOUNT_TOKEN);

      const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
      expect(entry).toMatchObject({
        kind: 'call',
        tool: 'github__list_branches',
        account_id: instance.github.id,
        resource_ref: 'acme/app',
        decision: 'allowed',
        // The bytes of the call (Activity's Overview): its arguments up, its result down.
        request_bytes: jsonBytes({ owner: 'acme', repo: 'app' }),
      });
      expect(entry?.kind === 'call' && entry.response_bytes).toBeGreaterThan(
        JSON.stringify(BRANCHES).length,
      );
      await client.close();
    });
  }

  it('hands the client the whole refusal: code, fields and hint in the JSON-RPC error data', async () => {
    const mission = await instance.issueGithub({ read: 'careful' });
    const client = await connect(instance, mission.token);

    const outside = await client
      .callTool({ name: 'github__list_branches', arguments: { owner: 'acme', repo: 'infra' } })
      .catch((err: unknown) => err);
    expect(outside).toBeInstanceOf(ProtocolError);
    expect((outside as ProtocolError).code).toBe(-32603);
    expect((outside as ProtocolError).data).toMatchObject({
      code: 'resource-not-in-mission',
      cited_ref: 'acme/infra',
      account: { id: instance.github.id, name: 'acme-org' },
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
    expect((body.result?.tools as unknown[]).length).toBe(githubPlugin.tools.length + 1);
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
    it('lists only the services the mission holds an account and an accepted risk for', async () => {
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

      expect(
        (await list(githubOnly)).every(
          (name) => name.startsWith('github__') || name === 'vaubaan__request_permission',
        ),
      ).toBe(true);
      expect((await list(depotOnly)).sort()).toEqual([
        'depot__create_space',
        'depot__purge',
        'depot__read_item',
        'depot__whoami',
        'depot__write_item',
        'vaubaan__request_permission',
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
      expect(tools.some((t) => t.service === 'github' && !t.callable)).toBe(true);
      expect(tools.filter((t) => t.callable).map((t) => t.service)).toEqual([
        ...Array<string>(5).fill('depot'),
        'vaubaan',
      ]);
      expect([...catalog.callable_tools].sort()).toEqual(
        tools
          .filter((t) => t.callable)
          .map((t) => t.name)
          .sort(),
      );
      expect(catalog.accounts).toEqual([
        {
          id: instance.account.id,
          service: 'depot',
          name: 'Depot main',
          status: 'active',
          resources: [
            { ref: 'app-staging', env: 'staging', display_name: 'app-staging' },
            { ref: 'scratch', env: 'staging', display_name: 'scratch' },
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

    it('refuses a browser origin other than the instance', async () => {
      const mission = await instance.issueGithub();
      const foreign = await instance.rpc(mission.token, LIST, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      const own = await instance.rpc(mission.token, LIST, { origin: TEST_PUBLIC_URL });
      expect(own.status).toBe(200);
    });
  });

  describe('token verification and rate limits', () => {
    const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const wrongSecret = (prefix: string, i: number, fill = 'a') =>
      `vbn_live_${prefix}_${String(i).padStart(32, fill)}`;

    /** The stored proof of a token, as the store holds it right now. */
    const storedHash = (of: GithubInstance, prefix: string) =>
      of.root.store.db
        .prepare('SELECT hash, hash_alg FROM mission_tokens WHERE prefix = ?')
        .get(prefix) as { hash: string; hash_alg: string };

    it('remembers no verification: a revocation is seen on the very next call', async () => {
      const mission = await instance.issueGithub();
      expect(storedHash(instance, mission.prefix)).toEqual({
        hash: digestApiKey(mission.token),
        hash_alg: 'sha256',
      });
      const burst = await Promise.all(
        Array.from({ length: 8 }, () => instance.rpc(mission.token, LIST)),
      );
      expect(burst.every((r) => r.status === 200)).toBe(true);

      await instance.root.missions.service.revoke(instance.ada, mission.mission.id);
      const after = await instance.rpc(mission.token, LIST);
      expect(after.body.error?.data).toMatchObject({ code: 'mission-inactive', status: 'revoked' });
    });

    it('answers 401 to every wrong secret on a real prefix, never 429, and the agent is never held', async () => {
      const mission = await instance.issueGithub();
      for (let i = 0; i < 40; i++) {
        expect((await instance.rpc(wrongSecret(mission.prefix, i), LIST)).status).toBe(401);
      }
      // No trusted proxy here: every caller shares one address. It does not matter any more.
      expect((await instance.rpc(mission.token, LIST)).status).toBe(200);
    });

    it('a row an earlier build stored as argon2id authenticates nothing (migration 0027 revoked them)', async () => {
      const mission = await instance.issueGithub();
      instance.root.store.db
        .prepare("UPDATE mission_tokens SET hash = ?, hash_alg = 'argon2id' WHERE prefix = ?")
        .run('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', mission.prefix);
      expect((await instance.rpc(mission.token, LIST)).status).toBe(401);
    });

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

  it('rejects a call whose arguments JSON cannot carry (`1e999`): the approver would have read `null`', async () => {
    const mission = await instance.issueGithub({ read: 'careful' });
    // Written by hand: `JSON.stringify` would already have turned the number into `null`.
    const body =
      '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"github__list_branches",' +
      '"arguments":{"owner":"acme","repo":"app","per_page":1e999}}}';
    const response = await instance.root.execution.handlers.mcp(
      new Request('https://gateway.example.com/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${mission.token}`,
        },
        body,
      }),
    );
    const answer = (await response.json()) as { error?: { code: number; message: string } };
    expect(answer.error?.code).toBe(-32602);
    expect(answer.error?.message).toContain("argument 'per_page' is Infinity");
    expect(instance.upstream.calls).toHaveLength(0);
    const [entry] = await instance.root.store.audit.list({ kind: 'call' });
    expect(entry).toMatchObject({ decision: 'refused', refusal_code: null });
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
    expect(all).not.toContain(ACCOUNT_TOKEN);
    expect(all).not.toContain('secrets/prod.env');
    expect(all).not.toContain('BEGIN PRIVATE KEY');
    expect(all).not.toContain('github-app-client-secret-never-sent');
    expect(all).toMatch(/"arguments_hash":"[0-9a-f]{64}"/);
  });
});
