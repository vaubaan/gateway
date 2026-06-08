import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { RailwayAdapter, type RailwayRefreshedTokens } from '../../src/railway-adapter.ts';

const baseAdmin: ProviderAdmin = {
  id: 'pa-r',
  organization_id: 'org-1',
  provider: 'railway',
  status: 'connected',
  installation_id: null,
  team_id: null,
  access_token_encrypted: new TextEncoder().encode('rlwy_at'),
  refresh_token_encrypted: new TextEncoder().encode('rlwy_rt'),
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'railway',
  resource_ref: '00000000-0000-4000-8000-000000000000',
  display_name: null,
  created_at: '2026-01-01',
};

/** Build a fake SSE response carrying a single JSON-RPC frame. */
function sseResponse(id: number, result: unknown) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(`event: message\ndata: ${payload}\n\n`),
  };
}

function sseErrorResponse(id: number, code: number, message: string) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(`event: message\ndata: ${payload}\n\n`),
  };
}

describe('RailwayAdapter — mintUpstreamToken', () => {
  test('returns stored token when not near expiry', async () => {
    const adapter = new RailwayAdapter();
    const { token } = await adapter.mintUpstreamToken({
      ...baseAdmin,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(token).toBe('rlwy_at');
  });

  test('throws when no access token', async () => {
    const adapter = new RailwayAdapter();
    await expect(
      adapter.mintUpstreamToken({ ...baseAdmin, access_token_encrypted: null }),
    ).rejects.toThrow(/access_token_encrypted/);
  });

  test('refreshes when within the expiry threshold and persists the new pair', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://backboard.railway.com/oauth/token');
      const body = (init.body as URLSearchParams).toString();
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('resource=https%3A%2F%2Fmcp.railway.com');
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'rlwy_at2',
            refresh_token: 'rlwy_rt2',
            expires_in: 3600,
          }),
      };
    });
    const persisted: RailwayRefreshedTokens[] = [];
    const adapter = new RailwayAdapter({
      fetchImpl: fetchImpl as never,
      clientId: 'cid',
      clientSecret: 'secret',
      persistRefresh: async (_a, tokens) => {
        persisted.push(tokens);
      },
    });
    const { token } = await adapter.mintUpstreamToken({
      ...baseAdmin,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(token).toBe('rlwy_at2');
    expect(persisted[0]?.accessToken).toBe('rlwy_at2');
    expect(persisted[0]?.refreshToken).toBe('rlwy_rt2');
  });

  test('falls back to the stale token if refresh has no credentials', async () => {
    const adapter = new RailwayAdapter();
    const { token } = await adapter.mintUpstreamToken({
      ...baseAdmin,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(token).toBe('rlwy_at');
  });
});

describe('RailwayAdapter — executeCall (rewrap mcp.railway.com)', () => {
  test('forwards JSON-RPC tools/call with stripped railway__ prefix', async () => {
    let capturedBody: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      const id = (JSON.parse(capturedBody) as { id: number }).id;
      return sseResponse(id, { projects: [{ id: 'proj-a' }] });
    });
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'railway__list-projects', {})) as {
      projects: { id: string }[];
    };
    expect(out.projects[0]?.id).toBe('proj-a');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mcp.railway.com/');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rlwy_at');
    const sent = JSON.parse(capturedBody as unknown as string) as {
      method: string;
      params: { name: string };
    };
    expect(sent.method).toBe('tools/call');
    expect(sent.params.name).toBe('list-projects'); // stripped railway__ prefix
  });

  test('surfaces upstream JSON-RPC errors', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const id = (JSON.parse(init.body as string) as { id: number }).id;
      return sseErrorResponse(id, -32602, 'invalid args');
    });
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'railway__get-status', { projectId: 'x' }),
    ).rejects.toThrow(/invalid args/);
  });

  test('surfaces HTTP errors from upstream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'railway__list-projects', {}),
    ).rejects.toThrow(/401/);
  });
});

describe('RailwayAdapter — validateBinding', () => {
  test('rejects a non-UUID resource_ref', async () => {
    const adapter = new RailwayAdapter();
    const res = await adapter.validateBinding(baseAdmin, 'not-a-uuid');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/UUID/);
  });

  test('accepts a UUID and confirms token liveness via whoami', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const id = (JSON.parse(init.body as string) as { id: number }).id;
      return sseResponse(id, { id: 'user-1' });
    });
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    const res = await adapter.validateBinding(baseAdmin, '00000000-0000-4000-8000-000000000000');
    expect(res.ok).toBe(true);
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1].body as string) as {
      params: { name: string };
    };
    expect(sent.params.name).toBe('whoami');
  });
});

describe('RailwayAdapter — classify', () => {
  const adapter = new RailwayAdapter();

  test('whoami → runtime/account:read (account-level, no binding check)', () => {
    const res = adapter.classify('railway__whoami', {}, []);
    expect(res).toEqual({
      capability: { provider: 'railway', plane: 'runtime', level: 'account', action: 'read' },
    });
  });

  test('list-deployments → runtime/deployment:read', () => {
    const res = adapter.classify('railway__list-deployments', {}, [binding]);
    expect(res).toEqual({
      capability: { provider: 'railway', plane: 'runtime', level: 'deployment', action: 'read' },
    });
  });

  test('redeploy on a bound project → runtime/deployment:write', () => {
    const res = adapter.classify(
      'railway__redeploy',
      { projectId: '00000000-0000-4000-8000-000000000000' },
      [binding],
    );
    expect(res).toEqual({
      capability: { provider: 'railway', plane: 'runtime', level: 'deployment', action: 'write' },
    });
  });

  test('create-project → runtime/account:write', () => {
    const res = adapter.classify('railway__create-project', { name: 'demo' }, []);
    expect(res).toEqual({
      capability: { provider: 'railway', plane: 'runtime', level: 'account', action: 'write' },
    });
  });

  test('denies an unbound projectId', () => {
    const res = adapter.classify('railway__redeploy', { projectId: 'unbound-id' }, [binding]);
    expect(res).toEqual({ denied: "railway project 'unbound-id' is not bound to this project." });
  });

  test('denies an unknown tool', () => {
    const res = adapter.classify('railway__nuke', {}, []);
    expect(res).toEqual({ denied: "unknown railway tool 'railway__nuke'." });
  });
});
