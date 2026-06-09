/**
 * Unit tests for the ssh__exec gateway path.
 *
 * Uses an in-memory McpGateway with a stub SSH adapter so no real SSH
 * connection is required. SSH uses the capability model :
 *   - `ssh:host/shell:read@<host_slug>`  — whitelisted commands only.
 *   - `ssh:host/shell:write@<host_slug>` — any command.
 * Read vs write is decided in `classifySsh` via the cmd → isReadAllowed match.
 */

import { describe, expect, test } from 'vitest';
import type { AccessTokenContext, Capability, Provider } from '@vaubaan/shared';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';
import { MemoryCacheClient, MemoryAuditWriter } from '@vaubaan/mcp-gateway';
import { McpGateway, type ContextLoader, type UpstreamAdapter } from '@vaubaan/mcp-gateway';
import { classifySsh, sshToolCapabilities } from '@vaubaan/providers-ssh';
import type { ExecResult } from '@vaubaan/providers-ssh';

const HOST = 'vps-rp';

function readCap(): Capability {
  return { provider: 'ssh', plane: 'host', level: 'shell', action: 'read', env: HOST };
}
function writeCap(): Capability {
  return { provider: 'ssh', plane: 'host', level: 'shell', action: 'write', env: HOST };
}

function fakeExec(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: 'ok',
    stderr: '',
    exit_code: 0,
    duration_ms: 5,
    truncated: false,
    ...overrides,
  };
}

interface StubbedSshAdapter extends UpstreamAdapter {
  executeCallSelfContained(
    ctx: AccessTokenContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

function buildSshAdapter(opts: {
  onExec: (ctx: AccessTokenContext, args: Record<string, unknown>) => Promise<unknown>;
}): StubbedSshAdapter {
  return {
    provider: 'ssh',
    availableTools: [
      { name: 'ssh__exec', description: 'Run SSH command', inputSchema: { type: 'object' } },
    ],
    selfContained: true,
    toolCapabilities: sshToolCapabilities,
    classify: classifySsh,
    executeCall: async () => {
      throw new Error('should not be called');
    },
    loadProviderAdmin: async () => null,
    executeCallSelfContained: async (ctx, _tool, args) => opts.onExec(ctx, args),
  };
}

async function buildGateway(sshAdapter: StubbedSshAdapter, capabilities: Capability[]) {
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
      single_use: false,
      consumed_at: null,
    },
    project: { id: 'proj1', slug: 'proj1', organization_id: 'org1' },
    organization: { id: 'org1', slug: 'org1', name: 'Org 1' },
    capabilities,
    bindings: [],
    provider_admins: [],
  };

  const loader: ContextLoader = {
    loadAccessTokenForAuth: async () => ({ id: 'at1', api_key_hash: apiKeyHash, status: 'active' }),
    loadAccessTokenContext: async () => ctx,
  };

  const upstreamByProvider: Partial<Record<Provider, UpstreamAdapter>> = {
    ssh: sshAdapter,
  };

  const gw = new McpGateway({
    cache: new MemoryCacheClient(),
    audit: new MemoryAuditWriter(),
    contextLoader: loader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
  });

  return { gw, apiKey, ctx };
}

describe('ssh__exec — read capability', () => {
  test('allows whitelisted command with shell:read@<host>', async () => {
    const adapter = buildSshAdapter({
      onExec: async () => fakeExec({ stdout: 'up 1 day' }),
    });
    const { gw, apiKey } = await buildGateway(adapter, [readCap()]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ssh__exec', arguments: { host_slug: HOST, cmd: 'uptime' } },
    });
    expect('result' in resp).toBe(true);
    if ('result' in resp) {
      const result = resp.result as { content: Array<{ text: string }> };
      expect(result.content[0]?.text).toContain('up 1 day');
    }
  });

  test('denies a write command with only shell:read@<host>', async () => {
    const adapter = buildSshAdapter({
      onExec: async () => fakeExec(),
    });
    const { gw, apiKey } = await buildGateway(adapter, [readCap()]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'ssh__exec',
        arguments: { host_slug: HOST, cmd: 'systemctl restart nginx' },
      },
    });
    expect('error' in resp).toBe(true);
    if ('error' in resp) expect(resp.error.message).toContain('Vaubaan policy denied');
  });
});

describe('ssh__exec — write capability', () => {
  test('allows any command with shell:write@<host>', async () => {
    const adapter = buildSshAdapter({
      onExec: async () => fakeExec({ stdout: 'restarted' }),
    });
    const { gw, apiKey } = await buildGateway(adapter, [writeCap()]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ssh__exec',
        arguments: { host_slug: HOST, cmd: 'systemctl restart nginx' },
      },
    });
    expect('result' in resp).toBe(true);
  });
});

describe('ssh__exec — env defensive', () => {
  test('denies a different host even with write@<other-host>', async () => {
    const adapter = buildSshAdapter({
      onExec: async () => fakeExec(),
    });
    const { gw, apiKey } = await buildGateway(adapter, [
      { provider: 'ssh', plane: 'host', level: 'shell', action: 'write', env: 'other-host' },
    ]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ssh__exec', arguments: { host_slug: HOST, cmd: 'uptime' } },
    });
    expect('error' in resp).toBe(true);
    if ('error' in resp) expect(resp.error.message).toContain('Vaubaan policy denied');
  });
});

describe('ssh__exec — adapter throws (unknown host)', () => {
  test('returns error when adapter throws for unknown host_slug', async () => {
    const adapter = buildSshAdapter({
      onExec: async () => {
        throw new Error("SSH binding 'unknown-host' not found for this project.");
      },
    });
    const { gw, apiKey } = await buildGateway(adapter, [
      { provider: 'ssh', plane: 'host', level: 'shell', action: 'read', env: 'unknown-host' },
    ]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ssh__exec', arguments: { host_slug: 'unknown-host', cmd: 'uptime' } },
    });
    expect('error' in resp).toBe(true);
    if ('error' in resp) expect(resp.error.message).toContain('not found');
  });
});

describe('ssh__exec — no capability', () => {
  test('denies when no ssh capability is granted', async () => {
    const adapter = buildSshAdapter({ onExec: async () => fakeExec() });
    const { gw, apiKey } = await buildGateway(adapter, []);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'ssh__exec', arguments: { host_slug: HOST, cmd: 'uptime' } },
    });
    expect('error' in resp).toBe(true);
    if ('error' in resp) expect(resp.error.message).toContain('denied');
  });
});

describe('tools/list — ssh visible only with a matching capability', () => {
  test('lists ssh__exec when shell:read is granted', async () => {
    const adapter = buildSshAdapter({ onExec: async () => fakeExec() });
    const { gw, apiKey } = await buildGateway(adapter, [readCap()]);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    });
    expect('result' in resp).toBe(true);
    if ('result' in resp) {
      const names = (resp.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(names).toContain('ssh__exec');
    }
  });

  test('hides ssh__exec when no ssh capability is granted', async () => {
    const adapter = buildSshAdapter({ onExec: async () => fakeExec() });
    const { gw, apiKey } = await buildGateway(adapter, []);
    const authCtx = await gw.authenticate(`Bearer ${apiKey}`);
    const resp = await gw.handle(authCtx, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/list',
    });
    expect('result' in resp).toBe(true);
    if ('result' in resp) {
      const names = (resp.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(names).not.toContain('ssh__exec');
    }
  });
});
