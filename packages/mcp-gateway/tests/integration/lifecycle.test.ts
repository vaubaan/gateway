/**
 * Integration test — end-to-end lifecycle without browser, without real Supabase.
 *
 * Spec : docs/spec/vaubaan-gateway.md §14.2.
 *
 * Coverage :
 *   - Bot api_key auth round-trip (generate → hash → lookup → verify).
 *   - Gateway authentication using an in-memory fake DB.
 *   - tools/list scoping (only allowed tools surface).
 *   - tools/call allowed → audit row decision='allowed'.
 *   - tools/call denied → audit row decision='denied' + actionable reason.
 *   - Bot revocation → next call 401.
 *   - api_key rotation invalidates the old key.
 *   - Provider disconnect → calls targeting that provider deny.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  type AccessTokenContext,
  type Capability,
  type ProviderAdmin,
  type ProviderBinding,
} from '@vaubaan/shared';
import { MemoryCacheClient } from '../../src/cache.ts';
import { MemoryAuditWriter } from '../../src/audit.ts';
import { McpGateway, type ContextLoader, type UpstreamAdapter } from '../../src/gateway.ts';
import { mockClassifyGithub, mockGithubToolCapabilities } from '../fixtures/github-classifier.ts';

// ─── In-memory "DB" ──────────────────────────────────────────────────────────

interface DbRow {
  token: {
    id: string;
    api_key_prefix: string;
    api_key_hash: string;
    status: 'active' | 'revoked';
    name: string;
  };
  context: AccessTokenContext;
  admin: ProviderAdmin;
}

class FakeDb {
  private tokens = new Map<string, DbRow>();

  addToken(row: DbRow): void {
    this.tokens.set(row.token.id, row);
  }

  byPrefix(prefix: string): DbRow | null {
    for (const r of this.tokens.values()) {
      if (r.token.api_key_prefix === prefix) return r;
    }
    return null;
  }

  byId(id: string): DbRow | null {
    return this.tokens.get(id) ?? null;
  }

  revoke(id: string): void {
    const row = this.tokens.get(id);
    if (row) row.token.status = 'revoked';
  }

  rotate(id: string, newPrefix: string, newHash: string): void {
    const row = this.tokens.get(id);
    if (row) {
      row.token.api_key_prefix = newPrefix;
      row.token.api_key_hash = newHash;
    }
  }

  disconnectProvider(tokenId: string): void {
    const row = this.tokens.get(tokenId);
    if (row) {
      row.admin.status = 'revoked';
      row.context.provider_admins = row.context.provider_admins.map((p) =>
        p.provider === row.admin.provider ? { ...p, status: 'revoked' } : p,
      );
    }
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Capability set equivalent to the old `github:developer` role : read the
// repo + write code on a feature branch only (env = feature/x). No
// write@main grant, so writes to protected branches and PR merges deny.
const developerCapabilities: Capability[] = [
  { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
  { provider: 'github', plane: 'repo', level: 'code', action: 'write', env: 'feature/x' },
];

const binding: ProviderBinding = {
  id: 'binding-1',
  project_id: 'p1',
  provider: 'github',
  resource_ref: 'acme/app',
  display_name: 'acme/app',
  created_at: '2026-01-01',
};

const adminConnected: ProviderAdmin = {
  id: 'admin-1',
  organization_id: 'org-1',
  provider: 'github',
  status: 'connected',
  installation_id: '99',
  team_id: null,
  access_token_encrypted: null,
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: 'user-1',
  connected_at: '2026-01-01',
};

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  db: FakeDb;
  audit: MemoryAuditWriter;
  cache: MemoryCacheClient;
  gateway: McpGateway;
  apiKey: string;
  tokenId: string;
  executeStub: (tool: string, args: Record<string, unknown>) => unknown;
}

async function buildHarness(
  executeStub?: (tool: string, args: Record<string, unknown>) => unknown,
): Promise<Harness> {
  const db = new FakeDb();
  const audit = new MemoryAuditWriter();
  const cache = new MemoryCacheClient();

  const { apiKey, apiKeyPrefix } = generateApiKey('test');
  const apiKeyHash = await hashApiKey(apiKey);

  const tokenId = 'tk-1';
  const ctx: AccessTokenContext = {
    access_token: {
      id: tokenId,
      name: 'ci-deploy',
      project_id: 'p1',
      status: 'active',
      api_key_prefix: apiKeyPrefix,
      expires_at: null,
    },
    project: { id: 'p1', slug: 'website', organization_id: 'org-1' },
    organization: { id: 'org-1', slug: 'acme', name: 'Acme' },
    capabilities: developerCapabilities,
    bindings: [binding],
    provider_admins: [
      { provider: 'github', status: 'connected', installation_id: '99', team_id: null },
    ],
  };

  db.addToken({
    token: {
      id: tokenId,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      name: 'ci-deploy',
    },
    context: ctx,
    admin: { ...adminConnected },
  });

  const loader: ContextLoader = {
    async loadAccessTokenForAuth(prefix) {
      const row = db.byPrefix(prefix);
      return row
        ? { id: row.token.id, api_key_hash: row.token.api_key_hash, status: row.token.status }
        : null;
    },
    async loadAccessTokenContext(id) {
      return db.byId(id)?.context ?? null;
    },
    async touchLastUsed() {},
  };

  const stubExec = executeStub ?? (() => ({ ok: true }));
  const githubAdapter: UpstreamAdapter = {
    provider: 'github',
    availableTools: [
      { name: 'github__list_branches', description: '', inputSchema: { type: 'object' } },
      { name: 'github__get_pull_request', description: '', inputSchema: { type: 'object' } },
      { name: 'github__create_pull_request', description: '', inputSchema: { type: 'object' } },
      { name: 'github__merge_pull_request', description: '', inputSchema: { type: 'object' } },
    ],
    toolCapabilities: mockGithubToolCapabilities,
    classify: mockClassifyGithub,
    async executeCall(_admin, _binding, tool, args) {
      return stubExec(tool, args);
    },
    async loadProviderAdmin(_orgId, _provider) {
      const row = db.byId(tokenId);
      return row?.admin ?? null;
    },
  };

  const gateway = new McpGateway({
    cache,
    audit,
    contextLoader: loader,
    upstreamByProvider: { github: githubAdapter } as never,
  });

  return { db, audit, cache, gateway, apiKey, tokenId, executeStub: stubExec };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('integration — lifecycle', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  test('auth → tools/list → tools/call (allowed) → audit row', async () => {
    const ctx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    expect(ctx.organization.slug).toBe('acme');

    const list = await harness.gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect('result' in list).toBe(true);
    if ('result' in list) {
      const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(tools).toContain('github__list_branches');
      expect(tools).toContain('github__create_pull_request');
      // merge_pull_request's surface is [code:write] ; the developer set has a
      // code:write @feature/x grant, so the tool IS discoverable (list filter is
      // env-ignored). The env defensive filter at call time denies the actual
      // merge — see the dedicated test below.
      expect(tools).toContain('github__merge_pull_request');
    }

    const call = await harness.gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'github__create_pull_request',
        arguments: { owner: 'acme', repo: 'app', head: 'feature/x', base: 'main', title: 'demo' },
      },
    });
    expect('result' in call).toBe(true);
    expect(harness.audit.rows).toHaveLength(1);
    expect(harness.audit.rows[0]?.decision).toBe('allowed');
    expect(harness.audit.rows[0]?.capability_matched).toBe('github:repo/code:write@feature/x');
    expect(harness.audit.rows[0]?.tool_name).toBe('github__create_pull_request');
  });

  test('write to a protected branch → denied for lack of code:write@main', async () => {
    const ctx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    const call = await harness.gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'github__create_or_update_file',
        arguments: {
          owner: 'acme',
          repo: 'app',
          path: 'README.md',
          message: 'sneaky',
          branch: 'main', // ← protected → requires code:write@main
          content: 'Zm9v',
        },
      },
    });
    expect('error' in call).toBe(true);
    if ('error' in call) {
      expect(call.error.message).toMatch(/Vaubaan policy denied/);
      expect(call.error.message).toMatch(/github:repo\/code:write@main/);
    }
    expect(harness.audit.rows[0]?.decision).toBe('denied');
  });

  test('access-token revocation → 401 on next call', async () => {
    const ctx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    expect(ctx.access_token.id).toBe('tk-1');
    harness.db.revoke('tk-1');
    // Cache hit + revoke → re-verify should reject.
    await expect(harness.gateway.authenticate(`Bearer ${harness.apiKey}`)).rejects.toThrow(
      /revoked/,
    );
  });

  test('api_key rotation: new key works, old key 401', async () => {
    // First, the old key works.
    await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    // Rotate.
    const { apiKey: newKey, apiKeyPrefix: newPrefix } = generateApiKey('test');
    const newHash = await hashApiKey(newKey);
    harness.db.rotate('tk-1', newPrefix, newHash);
    // Invalidate the cache so we re-load (in production, the rotate endpoint
    // explicitly invalidates cache).
    await harness.cache.del(
      `vaubaan:ctx:${harness.apiKey.slice('vbn_test_'.length, 'vbn_test_'.length + 8)}`,
    );
    // Old key — gone.
    await expect(harness.gateway.authenticate(`Bearer ${harness.apiKey}`)).rejects.toThrow();
    // Also update the context's stored prefix so the cache key matches the new one.
    const row = harness.db.byId('tk-1');
    if (row) row.context.access_token.api_key_prefix = newPrefix;
    // New key — works.
    const ctx = await harness.gateway.authenticate(`Bearer ${newKey}`);
    expect(ctx.access_token.id).toBe('tk-1');
  });

  test('provider disconnect → deny with explicit reason', async () => {
    const ctx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    harness.db.disconnectProvider('tk-1');
    // Force cache miss to pick up the change.
    await harness.cache.del(`vaubaan:ctx:${ctx.access_token.api_key_prefix}`);
    const freshCtx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    const call = await harness.gateway.handle(freshCtx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'github__list_branches',
        arguments: { owner: 'acme', repo: 'app' },
      },
    });
    expect('error' in call).toBe(true);
    if ('error' in call) expect(call.error.message).toMatch(/not connected/);
  });

  test('merge_pull_request denied: developer set lacks code:write@main', async () => {
    const ctx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    const call = await harness.gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'github__merge_pull_request',
        arguments: {
          owner: 'acme',
          repo: 'app',
          pull_number: 12,
        },
      },
    });
    expect('error' in call).toBe(true);
    if ('error' in call) expect(call.error.message).toMatch(/github:repo\/code:write@main/);
    expect(harness.audit.rows[0]?.decision).toBe('denied');
  });

  test('tool argument hash is computed and stored', async () => {
    const ctx = await harness.gateway.authenticate(`Bearer ${harness.apiKey}`);
    await harness.gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'github__list_branches',
        arguments: { owner: 'acme', repo: 'app' },
      },
    });
    expect(harness.audit.rows[0]?.arguments_hash).toMatch(/^[a-f0-9]{16}$/);
  });
});
