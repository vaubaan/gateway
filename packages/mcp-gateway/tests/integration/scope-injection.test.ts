/**
 * Integration test : end-to-end argument auto-injection.
 *
 * Verifies that when a bot's project has exactly one binding for a
 * provider, the resource args (owner/repo for github, projectId/teamId
 * for vercel, project_ref for supabase) are:
 *   - hidden from the tool's inputSchema returned by tools/list,
 *   - auto-injected into args before policy eval + dispatch.
 */

import { describe, expect, test, vi } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  type AccessTokenContext,
  type Capability,
  type McpToolDeclaration,
  type ProviderAdmin,
  type ProviderBinding,
} from '@vaubaan/shared';
import { MemoryAuditWriter } from '../../src/audit.ts';
import { MemoryCacheClient } from '../../src/cache.ts';
import { McpGateway, type ContextLoader, type UpstreamAdapter } from '../../src/gateway.ts';
import { mockClassifyGithub, mockGithubToolCapabilities } from '../fixtures/github-classifier.ts';

// Read-only capability set — equivalent to the old `github:reader` role.
const readerCapabilities: Capability[] = [
  { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
];

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'github',
  resource_ref: 'acme/playground',
  display_name: null,
  created_at: '2026-01-01',
};

const admin: ProviderAdmin = {
  id: 'pa1',
  organization_id: 'org1',
  provider: 'github',
  status: 'connected',
  installation_id: null,
  team_id: null,
  access_token_encrypted: new TextEncoder().encode('github_pat_xxx'),
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01',
};

const ghTools: McpToolDeclaration[] = [
  {
    name: 'github__list_branches',
    description: 'List branches.',
    inputSchema: {
      type: 'object',
      properties: { owner: {}, repo: {}, per_page: {} },
      required: ['owner', 'repo'],
    },
  },
];

async function harness() {
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
    project: { id: 'p1', slug: 'playground', organization_id: 'org1' },
    organization: { id: 'org1', slug: 'acme', name: 'Acme' },
    capabilities: readerCapabilities,
    bindings: [binding],
    provider_admins: [
      { provider: 'github', status: 'connected', installation_id: null, team_id: null },
    ],
  };
  const loader: ContextLoader = {
    loadAccessTokenForAuth: vi
      .fn()
      .mockResolvedValue({ id: 'tk1', api_key_hash: apiKeyHash, status: 'active' }),
    loadAccessTokenContext: vi.fn().mockResolvedValue(ctx),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
  };
  const execute = vi.fn().mockResolvedValue({ branches: [{ name: 'main' }] });
  const adapter: UpstreamAdapter = {
    provider: 'github',
    availableTools: ghTools,
    toolCapabilities: mockGithubToolCapabilities,
    classify: mockClassifyGithub,
    executeCall: execute,
    loadProviderAdmin: vi.fn().mockResolvedValue(admin),
  };
  const gateway = new McpGateway({
    cache: new MemoryCacheClient(),
    audit: new MemoryAuditWriter(),
    contextLoader: loader,
    upstreamByProvider: { github: adapter } as never,
  });
  return { gateway, ctx, execute, apiKey };
}

describe('scope injection — end-to-end', () => {
  test('tools/list hides owner+repo when project has exactly 1 github binding', async () => {
    const { gateway, ctx } = await harness();
    const res = await gateway.handle(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const tool = (res.result as { tools: McpToolDeclaration[] }).tools[0]!;
      const props = tool.inputSchema.properties ?? {};
      expect(props).not.toHaveProperty('owner');
      expect(props).not.toHaveProperty('repo');
      expect(props).toHaveProperty('per_page');
      expect(tool.inputSchema.required ?? []).not.toContain('owner');
      expect(tool.inputSchema.required ?? []).not.toContain('repo');
    }
  });

  test('tools/call without owner/repo succeeds and adapter receives injected values', async () => {
    const { gateway, ctx, execute } = await harness();
    const res = await gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'github__list_branches', arguments: {} },
    });
    expect('result' in res).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const lastCall = execute.mock.calls[0]!;
    const args = lastCall[3] as Record<string, string>;
    expect(args.owner).toBe('acme');
    expect(args.repo).toBe('playground');
  });

  test('caller-provided override that targets a different repo is denied by policy', async () => {
    // The injection merge keeps caller-provided owner='other', the policy
    // engine then sees owner+repo='other/playground' which is NOT in the
    // resolved project.repos = ['acme/playground'], so default-deny applies.
    const { gateway, ctx, execute } = await harness();
    const res = await gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'github__list_branches',
        arguments: { owner: 'other', repo: 'playground' },
      },
    });
    expect('error' in res).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
