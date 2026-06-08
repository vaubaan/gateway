import { describe, expect, test, vi } from 'vitest';
import type {
  AccessTokenContext,
  Capability,
  McpToolDeclaration,
  Provider,
  ProviderAdmin,
  ProviderBinding,
} from '@vaubaan/shared';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';
import { MemoryCacheClient } from '../../src/cache.ts';
import { MemoryAuditWriter } from '../../src/audit.ts';
import { McpGateway, type ContextLoader, type UpstreamAdapter } from '../../src/gateway.ts';
import { mockClassifyGithub, mockGithubToolCapabilities } from '../fixtures/github-classifier.ts';

// Capability set equivalent to the old `github:developer` role : read the
// repo + write code only on a feature branch (env = feature/x). It does NOT
// carry write@main, so writes to the protected branch and PR merges deny.
const developerCapabilities: Capability[] = [
  { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
  { provider: 'github', plane: 'repo', level: 'code', action: 'write', env: 'feature/x' },
];

const fakeBinding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'github',
  resource_ref: 'acme/app',
  display_name: 'acme/app',
  created_at: '2026-01-01',
};

const fakeAdmin: ProviderAdmin = {
  id: 'a1',
  organization_id: 'org1',
  provider: 'github',
  status: 'connected',
  installation_id: '99',
  team_id: null,
  access_token_encrypted: null,
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01',
};

const fakeTools: McpToolDeclaration[] = [
  { name: 'github__list_repos', description: '', inputSchema: { type: 'object' } },
  { name: 'github__get_file_contents', description: '', inputSchema: { type: 'object' } },
  { name: 'github__create_pull_request', description: '', inputSchema: { type: 'object' } },
  { name: 'github__delete_file', description: '', inputSchema: { type: 'object' } },
];

async function buildHarness(opts: { execute?: UpstreamAdapter['executeCall'] } = {}) {
  const { apiKey, apiKeyPrefix } = generateApiKey('test');
  const apiKeyHash = await hashApiKey(apiKey);

  const ctx: AccessTokenContext = {
    access_token: {
      id: 'tk1',
      name: 'ci-deploy',
      project_id: 'p1',
      status: 'active',
      api_key_prefix: apiKeyPrefix,
      expires_at: null,
      single_use: false,
      consumed_at: null,
    },
    project: { id: 'p1', slug: 'website', organization_id: 'org1' },
    organization: { id: 'org1', slug: 'acme', name: 'Acme' },
    capabilities: developerCapabilities,
    bindings: [fakeBinding],
    provider_admins: [
      { provider: 'github', status: 'connected', installation_id: '99', team_id: null },
    ],
  };

  const loader: ContextLoader = {
    loadAccessTokenForAuth: vi
      .fn()
      .mockResolvedValue({ id: 'tk1', api_key_hash: apiKeyHash, status: 'active' }),
    loadAccessTokenContext: vi.fn().mockResolvedValue(ctx),
    touchLastUsed: vi.fn(),
  };

  const githubAdapter: UpstreamAdapter = {
    provider: 'github',
    availableTools: fakeTools,
    toolCapabilities: mockGithubToolCapabilities,
    classify: mockClassifyGithub,
    executeCall: opts.execute ?? vi.fn().mockResolvedValue({ ok: true }),
    loadProviderAdmin: vi.fn().mockResolvedValue(fakeAdmin),
  };

  const cache = new MemoryCacheClient();
  const audit = new MemoryAuditWriter();
  const gateway = new McpGateway({
    cache,
    audit,
    contextLoader: loader,
    upstreamByProvider: {
      github: githubAdapter,
    } as Record<Provider, UpstreamAdapter>,
  });

  return { gateway, audit, loader, githubAdapter, apiKey, ctx };
}

describe('McpGateway — authenticate', () => {
  test('valid api_key returns context', async () => {
    const { gateway, apiKey } = await buildHarness();
    const ctx = await gateway.authenticate(`Bearer ${apiKey}`);
    expect(ctx.access_token.id).toBe('tk1');
  });

  test('missing header throws AuthError', async () => {
    const { gateway } = await buildHarness();
    await expect(gateway.authenticate(null)).rejects.toThrow(/Authorization/);
  });

  test('bad format throws AuthError', async () => {
    const { gateway } = await buildHarness();
    await expect(gateway.authenticate('Bearer notvalid')).rejects.toThrow();
  });

  test('cache hit re-verifies hash', async () => {
    const { gateway, apiKey, loader } = await buildHarness();
    await gateway.authenticate(`Bearer ${apiKey}`);
    await gateway.authenticate(`Bearer ${apiKey}`);
    // loadAccessTokenForAuth called twice (cache hit still re-verifies), loadAccessTokenContext once.
    expect(loader.loadAccessTokenForAuth).toHaveBeenCalledTimes(2);
    expect(loader.loadAccessTokenContext).toHaveBeenCalledTimes(1);
  });
});

describe('McpGateway — kind/expiry guards', () => {
  test('rejects vbn_mgmt_ keys (those auth /api/v1/mgmt/*, not the MCP gateway)', async () => {
    const { gateway } = await buildHarness();
    const { apiKey: mgmtKey } = generateApiKey('mgmt');
    await expect(gateway.authenticate(`Bearer ${mgmtKey}`)).rejects.toThrow(/management keys/i);
  });

  test('rejects an access token past expires_at on cold path', async () => {
    const { apiKey, apiKeyPrefix } = generateApiKey('test');
    const apiKeyHash = await hashApiKey(apiKey);
    const expired: AccessTokenContext = {
      access_token: {
        id: 'tk-exp',
        name: 'expired',
        project_id: 'p1',
        status: 'active',
        api_key_prefix: apiKeyPrefix,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        single_use: false,
        consumed_at: null,
      },
      project: { id: 'p1', slug: 'website', organization_id: 'org1' },
      organization: { id: 'org1', slug: 'acme', name: 'Acme' },
      capabilities: developerCapabilities,
      bindings: [fakeBinding],
      provider_admins: [
        { provider: 'github', status: 'connected', installation_id: '99', team_id: null },
      ],
    };
    const loader: ContextLoader = {
      loadAccessTokenForAuth: vi
        .fn()
        .mockResolvedValue({ id: 'tk-exp', api_key_hash: apiKeyHash, status: 'active' }),
      loadAccessTokenContext: vi.fn().mockResolvedValue(expired),
      touchLastUsed: vi.fn(),
    };
    const gateway = new McpGateway({
      cache: new MemoryCacheClient(),
      audit: new MemoryAuditWriter(),
      contextLoader: loader,
      upstreamByProvider: {} as Record<Provider, UpstreamAdapter>,
    });
    await expect(gateway.authenticate(`Bearer ${apiKey}`)).rejects.toThrow(/expired/);
  });
});

describe('McpGateway — tools/list', () => {
  test('returns filtered tool list', async () => {
    const { gateway, ctx } = await buildHarness();
    const res = await gateway.handle(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const tools = (res.result as { tools: McpToolDeclaration[] }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain('github__list_repos');
      expect(names).toContain('github__get_file_contents');
      expect(names).toContain('github__create_pull_request');
      // The list filter is env-ignored : delete_file's surface is [code:write],
      // and the developer holds a code:write @feature/x grant, so the tool is
      // discoverable. Env-scoped enforcement (write@main denial) is at call time.
      expect(names).toContain('github__delete_file');
    }
  });
});

describe('McpGateway — tools/call allowed', () => {
  test('routes through adapter and audits', async () => {
    const exec = vi.fn().mockResolvedValue({ number: 42 });
    const { gateway, audit, ctx } = await buildHarness({ execute: exec });
    const res = await gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'github__create_pull_request',
        arguments: {
          owner: 'acme',
          repo: 'app',
          head: 'feature/x',
          base: 'main',
          title: 'wip',
        },
      },
    });
    expect('result' in res).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      decision: 'allowed',
      tool_name: 'github__create_pull_request',
      capability_matched: 'github:repo/code:write@feature/x',
    });
  });
});

describe('McpGateway — tools/call denied', () => {
  test('write to a protected branch needs code:write@main, which developer lacks', async () => {
    const { gateway, audit, ctx } = await buildHarness();
    const res = await gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'github__create_or_update_file',
        arguments: {
          owner: 'acme',
          repo: 'app',
          path: 'x.md',
          message: 'sneaky',
          branch: 'main', // ← protected → requires code:write@main
          content: 'Zm9v',
        },
      },
    });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.message).toMatch(/Vaubaan policy denied/);
      expect(res.error.message).toMatch(/github:repo\/code:write@main/);
    }
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      decision: 'denied',
      tool_name: 'github__create_or_update_file',
    });
  });

  test('merge_pull_request needs code:write@main, which developer lacks', async () => {
    const { gateway, audit, ctx } = await buildHarness();
    const res = await gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'github__merge_pull_request',
        arguments: {
          owner: 'acme',
          repo: 'app',
          pull_number: 7,
        },
      },
    });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.code).toBe(-32603);
      expect(res.error.message).toMatch(/github:repo\/code:write@main/);
    }
    expect(audit.rows[0]).toMatchObject({ decision: 'denied' });
  });

  test('disconnected provider → deny', async () => {
    const { gateway, ctx } = await buildHarness();
    const brokenCtx = { ...ctx, provider_admins: [] };
    const res = await gateway.handle(brokenCtx, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'github__list_repos', arguments: { owner: 'acme', repo: 'app' } },
    });
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error.message).toMatch(/not connected/);
  });
});

describe('McpGateway — unknown method', () => {
  test('returns -32601', async () => {
    const { gateway, ctx } = await buildHarness();
    const res = await gateway.handle(ctx, { jsonrpc: '2.0', id: 11, method: 'wat' });
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error.code).toBe(-32601);
  });
});

describe('McpGateway — single-use tokens', () => {
  test('first matching call allowed, token consumed; second call rejected', async () => {
    // Read-only single-use token : the developer set has code:read, so the
    // first list_repos call wins ; the second hits the consumed gate.
    const { apiKey, apiKeyPrefix } = generateApiKey('test');
    const apiKeyHash = await hashApiKey(apiKey);

    // Mutable mirror of the access_token row : the loader updates it on
    // consumeAccessToken so the next loadAccessTokenContext picks up the new
    // consumed_at and authenticate() rejects.
    const tokenState = {
      consumed_at: null as string | null,
      status: 'active' as 'active' | 'revoked',
    };
    const ctx: AccessTokenContext = {
      access_token: {
        id: 'tk-su',
        name: 'single-use',
        project_id: 'p1',
        status: 'active',
        api_key_prefix: apiKeyPrefix,
        expires_at: null,
        single_use: true,
        consumed_at: null,
      },
      project: { id: 'p1', slug: 'website', organization_id: 'org1' },
      organization: { id: 'org1', slug: 'acme', name: 'Acme' },
      capabilities: [{ provider: 'github', plane: 'repo', level: 'code', action: 'read' }],
      bindings: [fakeBinding],
      provider_admins: [
        { provider: 'github', status: 'connected', installation_id: '99', team_id: null },
      ],
    };
    const loader: ContextLoader = {
      loadAccessTokenForAuth: vi.fn().mockImplementation(async () => ({
        id: 'tk-su',
        api_key_hash: apiKeyHash,
        status: tokenState.status,
      })),
      loadAccessTokenContext: vi.fn().mockImplementation(async () => ({
        ...ctx,
        access_token: { ...ctx.access_token, consumed_at: tokenState.consumed_at },
      })),
      touchLastUsed: vi.fn(),
      consumeAccessToken: vi.fn().mockImplementation(async () => {
        if (tokenState.consumed_at !== null) return false;
        tokenState.consumed_at = new Date().toISOString();
        tokenState.status = 'revoked';
        return true;
      }),
    };

    const githubAdapter: UpstreamAdapter = {
      provider: 'github',
      availableTools: fakeTools,
      toolCapabilities: mockGithubToolCapabilities,
      classify: mockClassifyGithub,
      executeCall: vi.fn().mockResolvedValue({ ok: true }),
      loadProviderAdmin: vi.fn().mockResolvedValue(fakeAdmin),
    };
    const cache = new MemoryCacheClient();
    const gateway = new McpGateway({
      cache,
      audit: new MemoryAuditWriter(),
      contextLoader: loader,
      upstreamByProvider: { github: githubAdapter } as Record<Provider, UpstreamAdapter>,
    });

    // 1st call : authenticated + executes + consumes.
    const auth1 = await gateway.authenticate(`Bearer ${apiKey}`);
    const call1 = await gateway.handle(auth1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'github__list_repos', arguments: { owner: 'acme', repo: 'app' } },
    });
    expect('result' in call1).toBe(true);
    expect(loader.consumeAccessToken).toHaveBeenCalledTimes(1);

    // 2nd call : token is now consumed → authenticate rejects.
    await expect(gateway.authenticate(`Bearer ${apiKey}`)).rejects.toThrow(/consumed|revoked/);
  });
});

describe('McpGateway — initialize', () => {
  test('returns MCP server info', async () => {
    const { gateway, ctx } = await buildHarness();
    const res = await gateway.handle(ctx, { jsonrpc: '2.0', id: 12, method: 'initialize' });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      expect((res.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
        'vaubaan-gateway',
      );
    }
  });
});
