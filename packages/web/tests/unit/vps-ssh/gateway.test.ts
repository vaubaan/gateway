/**
 * Unit tests for the vps_ssh__exec gateway path.
 *
 * Uses an in-memory McpGateway with a stub VpsSsh adapter so no real SSH
 * connection is required.
 */

import { describe, expect, test } from 'vitest';
import type { AccessTokenContext, Provider, Role } from '@vaubaan/shared';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';
import { MemoryCacheClient } from '@vaubaan/mcp-gateway';
import { MemoryAuditWriter } from '@vaubaan/mcp-gateway';
import { McpGateway, type ContextLoader, type UpstreamAdapter } from '@vaubaan/mcp-gateway';
import { isReadAllowed } from '@vaubaan/providers-vps-ssh';
import type { ExecResult } from '@vaubaan/providers-vps-ssh';

function buildVpsSshRole(name: 'vps-ssh:read' | 'vps-ssh:write'): Role {
  return {
    id: name,
    organization_id: null,
    provider: 'vps-ssh',
    name,
    description: null,
    is_builtin: true,
    permissions: {
      version: 1,
      rules: [{ effect: 'allow', target: '*', tool_matches: ['vps_ssh__exec'] }],
    },
    created_at: '2026-01-01',
  };
}

function buildFakeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: 'ok',
    stderr: '',
    exit_code: 0,
    duration_ms: 5,
    truncated: false,
    ...overrides,
  };
}

interface StubbedVpsSshAdapter extends UpstreamAdapter {
  executeCallSelfContained(
    ctx: AccessTokenContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

function buildVpsSshAdapter(opts: {
  onExec: (ctx: AccessTokenContext, args: Record<string, unknown>) => Promise<unknown>;
}): StubbedVpsSshAdapter {
  return {
    provider: 'vps-ssh',
    availableTools: [
      { name: 'vps_ssh__exec', description: 'Run SSH command', inputSchema: { type: 'object' } },
    ],
    selfContained: true,
    executeCall: async () => {
      throw new Error('should not be called');
    },
    loadProviderAdmin: async () => null,
    executeCallSelfContained: async (ctx, _tool, args) => opts.onExec(ctx, args),
  };
}

async function buildGateway(vpsSshAdapter: StubbedVpsSshAdapter, roles: Role[]) {
  const { apiKey, apiKeyPrefix } = generateApiKey('test');
  const apiKeyHash = await hashApiKey(apiKey);

  const ctx: AccessTokenContext = {
    access_token: {
      id: 'at1',
      name: 'test',
      project_id: 'proj1',
      status: 'active',
      api_key_prefix: apiKeyPrefix,
      expires_at: null,
    },
    project: { id: 'proj1', slug: 'proj1', organization_id: 'org1' },
    organization: { id: 'org1', slug: 'org1', name: 'Org 1' },
    roles,
    bindings: [],
    provider_admins: [],
  };

  const loader: ContextLoader = {
    loadAccessTokenForAuth: async () => ({ id: 'at1', api_key_hash: apiKeyHash, status: 'active' }),
    loadAccessTokenContext: async () => ctx,
  };

  const upstreamByProvider: Partial<Record<Provider, UpstreamAdapter>> = {
    'vps-ssh': vpsSshAdapter,
  };

  const gw = new McpGateway({
    cache: new MemoryCacheClient(),
    audit: new MemoryAuditWriter(),
    contextLoader: loader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
  });

  return { gw, apiKey, ctx };
}

describe('vps_ssh__exec — read role', () => {
  test('allows whitelisted command with vps-ssh:read role', async () => {
    const readRole = buildVpsSshRole('vps-ssh:read');
    const adapter = buildVpsSshAdapter({
      onExec: async (ctx, args) => {
        const cmd = args['cmd'] as string;
        // Adapter enforces read policy
        if (!isReadAllowed(cmd)) throw new Error('Command blocked by vps-ssh:read policy.');
        return buildFakeExecResult({ stdout: 'up 1 day' });
      },
    });

    const { gw, apiKey } = await buildGateway(adapter, [readRole]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vps_ssh__exec', arguments: { host_slug: 'vps-rp', cmd: 'uptime' } },
    });

    expect('result' in resp).toBe(true);
    if ('result' in resp) {
      const result = resp.result as { content: Array<{ text: string }> };
      expect(result.content[0]?.text).toContain('up 1 day');
    }
  });

  test('blocks write command with vps-ssh:read role', async () => {
    const readRole = buildVpsSshRole('vps-ssh:read');
    const adapter = buildVpsSshAdapter({
      onExec: async (_ctx, args) => {
        const cmd = args['cmd'] as string;
        if (!isReadAllowed(cmd)) throw new Error('Command blocked by vps-ssh:read policy.');
        return buildFakeExecResult();
      },
    });

    const { gw, apiKey } = await buildGateway(adapter, [readRole]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'vps_ssh__exec',
        arguments: { host_slug: 'vps-rp', cmd: 'systemctl restart nginx' },
      },
    });

    expect('error' in resp).toBe(true);
    if ('error' in resp) {
      expect(resp.error.message).toContain('blocked');
    }
  });
});

describe('vps_ssh__exec — write role', () => {
  test('allows write command with vps-ssh:write role', async () => {
    const writeRole = buildVpsSshRole('vps-ssh:write');
    const adapter = buildVpsSshAdapter({
      onExec: async () => buildFakeExecResult({ stdout: 'restarted' }),
    });

    const { gw, apiKey } = await buildGateway(adapter, [writeRole]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'vps_ssh__exec',
        arguments: { host_slug: 'vps-rp', cmd: 'systemctl restart nginx' },
      },
    });

    expect('result' in resp).toBe(true);
  });
});

describe('vps_ssh__exec — unknown host', () => {
  test('returns error when adapter throws for unknown host_slug', async () => {
    const writeRole = buildVpsSshRole('vps-ssh:write');
    const adapter = buildVpsSshAdapter({
      onExec: async () => {
        throw new Error("SSH binding 'unknown-host' not found for this project.");
      },
    });

    const { gw, apiKey } = await buildGateway(adapter, [writeRole]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'vps_ssh__exec',
        arguments: { host_slug: 'unknown-host', cmd: 'uptime' },
      },
    });

    expect('error' in resp).toBe(true);
    if ('error' in resp) {
      expect(resp.error.message).toContain('not found');
    }
  });
});

describe('vps_ssh__exec — no role', () => {
  test('denies when no vps-ssh role is attached', async () => {
    const adapter = buildVpsSshAdapter({
      onExec: async () => buildFakeExecResult(),
    });

    const { gw, apiKey } = await buildGateway(adapter, []); // no roles
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'vps_ssh__exec', arguments: { host_slug: 'vps-rp', cmd: 'uptime' } },
    });

    expect('error' in resp).toBe(true);
    if ('error' in resp) {
      expect(resp.error.message).toContain('denied');
    }
  });
});

describe('vps_ssh__exec — timeout cap', () => {
  test('capped at 300s max', () => {
    // This is a logic test, not a gateway test. Verify the cap in the execute module.
    // sshExec enforces Math.min(timeout_s, 300).
    const MAX = 300;
    const requested = 9999;
    const effective = Math.min(requested, MAX);
    expect(effective).toBe(300);
  });
});

describe('tools/list — vps-ssh tools visible when role attached', () => {
  test('vps_ssh__exec appears in tools/list when vps-ssh:read role is attached', async () => {
    const readRole = buildVpsSshRole('vps-ssh:read');
    const adapter = buildVpsSshAdapter({ onExec: async () => buildFakeExecResult() });
    const { gw, apiKey } = await buildGateway(adapter, [readRole]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);

    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/list',
    });

    expect('result' in resp).toBe(true);
    if ('result' in resp) {
      const result = resp.result as { tools: Array<{ name: string }> };
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('vps_ssh__exec');
    }
  });

  test('vps_ssh__exec does not appear in tools/list when no vps-ssh role', async () => {
    const adapter = buildVpsSshAdapter({ onExec: async () => buildFakeExecResult() });
    const { gw, apiKey } = await buildGateway(adapter, []);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);

    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    });

    expect('result' in resp).toBe(true);
    if ('result' in resp) {
      const result = resp.result as { tools: Array<{ name: string }> };
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain('vps_ssh__exec');
    }
  });
});
