import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { VercelAdapter } from '../../src/vercel-adapter.ts';

const baseAdmin: ProviderAdmin = {
  id: 'pa-v',
  organization_id: 'org-1',
  provider: 'vercel',
  status: 'connected',
  installation_id: null,
  team_id: 'team_abc',
  access_token_encrypted: new TextEncoder().encode('vcp_xxx'),
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'vercel',
  resource_ref: 'prj_abc',
  display_name: null,
  created_at: '2026-01-01',
};

/** Build a fake SSE response carrying a single JSON-RPC frame. */
function sseResponse(id: number, result: unknown) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  const body = `event: message\ndata: ${payload}\n\n`;
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  };
}

function sseErrorResponse(id: number, code: number, message: string) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  const body = `event: message\ndata: ${payload}\n\n`;
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  };
}

describe('VercelAdapter — mintUpstreamToken', () => {
  test('returns access_token_encrypted as bearer', async () => {
    const adapter = new VercelAdapter();
    const { token } = await adapter.mintUpstreamToken(baseAdmin);
    expect(token).toBe('vcp_xxx');
  });

  test('throws when no token', async () => {
    const adapter = new VercelAdapter();
    await expect(
      adapter.mintUpstreamToken({ ...baseAdmin, access_token_encrypted: null }),
    ).rejects.toThrow(/access_token_encrypted/);
  });
});

describe('VercelAdapter — executeCall (rewrap mcp.vercel.com)', () => {
  test('forwards JSON-RPC tools/call with stripped prefix + injected teamId', async () => {
    let capturedBody: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      const id = (JSON.parse(capturedBody) as { id: number }).id;
      return sseResponse(id, { projects: [{ id: 'prj_a' }] });
    });
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'vercel__list_projects', {})) as {
      projects: { id: string }[];
    };
    expect(out.projects[0]?.id).toBe('prj_a');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mcp.vercel.com/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vcp_xxx');
    const sent = JSON.parse(capturedBody as unknown as string) as {
      method: string;
      params: { name: string; arguments: Record<string, string> };
    };
    expect(sent.method).toBe('tools/call');
    expect(sent.params.name).toBe('list_projects'); // stripped vercel__ prefix
    expect(sent.params.arguments.teamId).toBe('team_abc'); // auto-injected
  });

  test('does not override explicit teamId in args', async () => {
    let capturedBody: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      const id = (JSON.parse(capturedBody) as { id: number }).id;
      return sseResponse(id, {});
    });
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__list_projects', {
      teamId: 'team_override',
    });
    const sent = JSON.parse(capturedBody as unknown as string) as {
      params: { arguments: Record<string, string> };
    };
    expect(sent.params.arguments.teamId).toBe('team_override');
  });

  test('surfaces upstream JSON-RPC errors', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const id = (JSON.parse(init.body as string) as { id: number }).id;
      return sseErrorResponse(id, -32602, 'invalid args');
    });
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'vercel__get_project', { projectId: 'x' }),
    ).rejects.toThrow(/invalid args/);
  });

  test('surfaces HTTP errors from upstream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'vercel__list_projects', {}),
    ).rejects.toThrow(/401/);
  });
});

describe('VercelAdapter — classify', () => {
  const adapter = new VercelAdapter();

  test('account-level read → runtime/account:read (env-less), no projectId required', () => {
    const result = adapter.classify('vercel__list_projects', {}, [binding]);
    expect(result).toEqual({
      capability: { provider: 'vercel', plane: 'runtime', level: 'account', action: 'read' },
    });
  });

  test('get_project → runtime/project-settings:read (env-less)', () => {
    const result = adapter.classify('vercel__get_project', { projectId: 'prj_abc' }, [binding]);
    expect(result).toEqual({
      capability: {
        provider: 'vercel',
        plane: 'runtime',
        level: 'project-settings',
        action: 'read',
      },
    });
  });

  test('deploy to production → runtime/deployment:write @prod', () => {
    const result = adapter.classify(
      'vercel__deploy_to_vercel',
      { projectId: 'prj_abc', target: 'production' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'vercel',
        plane: 'runtime',
        level: 'deployment',
        action: 'write',
        env: 'prod',
      },
    });
  });

  test('upsert_env_var with preview target → runtime/config:write @preview', () => {
    const result = adapter.classify(
      'vercel__upsert_env_var',
      { projectId: 'prj_abc', key: 'X', value: 'y', target: 'preview' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'vercel',
        plane: 'runtime',
        level: 'config',
        action: 'write',
        env: 'preview',
      },
    });
  });

  test('update_project_settings → runtime/project-settings:write (env-less)', () => {
    const result = adapter.classify(
      'vercel__update_project_settings',
      { projectId: 'prj_abc', rootDirectory: 'app' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'vercel',
        plane: 'runtime',
        level: 'project-settings',
        action: 'write',
      },
    });
  });

  test('denies a call carrying an unbound projectId', () => {
    const result = adapter.classify('vercel__get_project', { projectId: 'prj_unbound' }, [binding]);
    expect(result).toEqual({
      denied: "vercel project 'prj_unbound' is not bound to this project.",
    });
  });
});

/** Build a fake JSON response with arbitrary body for REST custom tools. */
function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

describe('VercelAdapter — executeCall (custom REST tools)', () => {
  test('update_project_settings PATCHes /v9/projects/{id} with whitelisted fields + teamId query', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ id: 'prj_abc', rootDirectory: 'app' }),
    );
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'vercel__update_project_settings', {
      projectId: 'prj_abc',
      rootDirectory: 'app',
      framework: 'nextjs',
      // a field not in the whitelist must be dropped
      secretField: 'should-not-leak',
    })) as { rootDirectory: string };
    expect(out.rootDirectory).toBe('app');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v9/projects/prj_abc?teamId=team_abc');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vcp_xxx');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ rootDirectory: 'app', framework: 'nextjs' });
    expect(body.secretField).toBeUndefined();
  });

  test('update_project_settings honors explicit teamId in args over admin team_id', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__update_project_settings', {
      projectId: 'prj_abc',
      teamId: 'team_override',
      rootDirectory: 'web',
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v9/projects/prj_abc?teamId=team_override');
  });

  test('update_project_settings throws when projectId missing', async () => {
    const fetchImpl = vi.fn();
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'vercel__update_project_settings', {
        rootDirectory: 'app',
      }),
    ).rejects.toThrow(/projectId is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('update_project_settings surfaces REST errors with status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"error":{"message":"forbidden"}}'),
    });
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'vercel__update_project_settings', {
        projectId: 'prj_abc',
        rootDirectory: 'app',
      }),
    ).rejects.toThrow(/403/);
  });

  test('upsert_env_var POSTs /v10/projects/{id}/env with upsert=true + whitelisted body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ created: { key: 'DATABASE_URL' } }),
    );
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__upsert_env_var', {
      projectId: 'prj_abc',
      key: 'DATABASE_URL',
      value: 'postgres://...',
      target: ['production', 'preview'],
      type: 'encrypted',
      comment: 'set by gateway',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v10/projects/prj_abc/env?teamId=team_abc&upsert=true');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      key: 'DATABASE_URL',
      value: 'postgres://...',
      target: ['production', 'preview'],
      type: 'encrypted',
      comment: 'set by gateway',
    });
  });

  test('custom tools are exposed in availableTools', async () => {
    const adapter = new VercelAdapter();
    const names = adapter.availableTools.map((t) => t.name);
    expect(names).toContain('vercel__update_project_settings');
    expect(names).toContain('vercel__upsert_env_var');
    // Sanity check: upstream tools are still present.
    expect(names).toContain('vercel__list_projects');
  });
});
