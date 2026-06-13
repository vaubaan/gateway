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
  environment: 'staging',
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

  test('list-deployments → runtime/deployment:read @staging (env from binding)', () => {
    const res = adapter.classify('railway__list-deployments', {}, [binding]);
    expect(res).toEqual({
      capability: {
        provider: 'railway',
        plane: 'runtime',
        level: 'deployment',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('redeploy on a bound project → runtime/deployment:write @staging', () => {
    const res = adapter.classify(
      'railway__redeploy',
      { projectId: '00000000-0000-4000-8000-000000000000' },
      [binding],
    );
    expect(res).toEqual({
      capability: {
        provider: 'railway',
        plane: 'runtime',
        level: 'deployment',
        action: 'write',
        env: 'staging',
      },
    });
  });

  test('binding with environment=null yields an env-less deployment capability', () => {
    const envlessBinding: ProviderBinding = { ...binding, environment: null };
    const res = adapter.classify('railway__list-deployments', {}, [envlessBinding]);
    expect(res).toEqual({
      capability: { provider: 'railway', plane: 'runtime', level: 'deployment', action: 'read' },
    });
  });

  test('railway-agent stays env-less (account-level, no project arg)', () => {
    const res = adapter.classify('railway__railway-agent', { instruction: 'noop' }, [binding]);
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

  test('denies ambiguous deployment call with multiple bindings', () => {
    const other: ProviderBinding = {
      ...binding,
      id: 'b2',
      resource_ref: '11111111-1111-4111-8111-111111111111',
      environment: 'prod',
    };
    const res = adapter.classify('railway__list-deployments', {}, [binding, other]);
    expect(res).toEqual({ denied: 'ambiguous railway target: specify projectId.' });
  });

  test('denies an unknown tool', () => {
    const res = adapter.classify('railway__nuke', {}, []);
    expect(res).toEqual({ denied: "unknown railway tool 'railway__nuke'." });
  });

  test('list-variables → runtime/config:read @staging (env from binding)', () => {
    const res = adapter.classify('railway__list-variables', { environmentId: 'env-uuid-1' }, [
      binding,
    ]);
    expect(res).toEqual({
      capability: {
        provider: 'railway',
        plane: 'runtime',
        level: 'config',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('upsert-variable → runtime/config:write @staging', () => {
    const res = adapter.classify(
      'railway__upsert-variable',
      {
        projectId: '00000000-0000-4000-8000-000000000000',
        environmentId: 'env-uuid-1',
        name: 'API_KEY',
        value: 'k',
      },
      [binding],
    );
    expect(res).toEqual({
      capability: {
        provider: 'railway',
        plane: 'runtime',
        level: 'config',
        action: 'write',
        env: 'staging',
      },
    });
  });

  test('delete-variable → runtime/config:write @staging', () => {
    const res = adapter.classify(
      'railway__delete-variable',
      {
        projectId: '00000000-0000-4000-8000-000000000000',
        environmentId: 'env-uuid-1',
        name: 'API_KEY',
      },
      [binding],
    );
    expect(res).toEqual({
      capability: {
        provider: 'railway',
        plane: 'runtime',
        level: 'config',
        action: 'write',
        env: 'staging',
      },
    });
  });
});

describe('RailwayAdapter — executeCall (custom GraphQL env-var tools)', () => {
  function jsonOk(body: unknown) {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  }

  test('list-variables POSTs the variables query to backboard and returns the map', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonOk({
        data: { variables: { DATABASE_URL: 'postgres://...', NODE_ENV: 'production' } },
      }),
    );
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    const out = await adapter.executeCall(baseAdmin, binding, 'railway__list-variables', {
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
    });
    expect(out).toEqual({ DATABASE_URL: 'postgres://...', NODE_ENV: 'production' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://backboard.railway.com/graphql/v2');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rlwy_at');
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('query variables');
    expect(body.variables).toEqual({
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      serviceId: null,
      unrendered: false,
    });
  });

  test('upsert-variable sends the variableUpsert mutation with input stripped of undefined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonOk({ data: { variableUpsert: true } }));
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    const out = await adapter.executeCall(baseAdmin, binding, 'railway__upsert-variable', {
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      name: 'API_KEY',
      value: 'k1',
      // serviceId and skipDeploys deliberately omitted
    });
    expect(out).toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain('mutation variableUpsert');
    expect(body.variables.input).toEqual({
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      name: 'API_KEY',
      value: 'k1',
    });
  });

  test('upsert-variables (bulk) sends variableCollectionUpsert with replace flag', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonOk({ data: { variableCollectionUpsert: true } }));
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'railway__upsert-variables', {
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      serviceId: 'svc-1',
      variables: { A: '1', B: '2' },
      replace: true,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain('mutation variableCollectionUpsert');
    expect(body.variables.input).toEqual({
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      serviceId: 'svc-1',
      variables: { A: '1', B: '2' },
      replace: true,
    });
  });

  test('delete-variable sends the variableDelete mutation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonOk({ data: { variableDelete: true } }));
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'railway__delete-variable', {
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      name: 'OLD_KEY',
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain('mutation variableDelete');
    expect(body.variables.input).toEqual({
      projectId: '00000000-0000-4000-8000-000000000000',
      environmentId: 'env-uuid-1',
      name: 'OLD_KEY',
    });
  });

  test('surfaces backboard 401 (audience-bound token) as a clear error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'railway__list-variables', {
        environmentId: 'env-uuid-1',
      }),
    ).rejects.toThrow(/Railway GraphQL 401/);
  });

  test('surfaces GraphQL `errors` array', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonOk({ errors: [{ message: 'project not found' }] }));
    const adapter = new RailwayAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'railway__upsert-variable', {
        projectId: '00000000-0000-4000-8000-000000000000',
        environmentId: 'env-uuid-1',
        name: 'K',
        value: 'V',
      }),
    ).rejects.toThrow(/project not found/);
  });
});
