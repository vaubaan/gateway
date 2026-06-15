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
    expect(names).toContain('vercel__list_env_vars');
    expect(names).toContain('vercel__delete_env_var');
    // Sanity check: upstream tools are still present.
    expect(names).toContain('vercel__list_projects');
  });

  test('list_env_vars GETs /v10/projects/{id}/env with no body and teamId query', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ envs: [{ id: 'env_a', key: 'X', target: ['production'] }] }),
    );
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'vercel__list_env_vars', {
      projectId: 'prj_abc',
    })) as { envs: { id: string }[] };
    expect(out.envs[0]?.id).toBe('env_a');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v10/projects/prj_abc/env?teamId=team_abc');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  test('list_env_vars passes decrypt=true when requested', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ envs: [] }));
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__list_env_vars', {
      projectId: 'prj_abc',
      decrypt: true,
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.vercel.com/v10/projects/prj_abc/env?teamId=team_abc&decrypt=true',
    );
  });

  test('delete_env_var DELETEs /v9/projects/{id}/env/{envId} with no body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__delete_env_var', {
      projectId: 'prj_abc',
      id: 'env_xyz',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v9/projects/prj_abc/env/env_xyz?teamId=team_abc');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  test('delete_env_var throws when id missing', async () => {
    const fetchImpl = vi.fn();
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'vercel__delete_env_var', { projectId: 'prj_abc' }),
    ).rejects.toThrow(/id is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('VercelAdapter — executeCall (custom domain + protection tools)', () => {
  test('list_project_domains GETs /v9/projects/{id}/domains with teamId query', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ domains: [{ name: 'example.com', verified: true }] }),
    );
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'vercel__list_project_domains', {
      projectId: 'prj_abc',
    })) as { domains: { name: string }[] };
    expect(out.domains[0]?.name).toBe('example.com');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v9/projects/prj_abc/domains?teamId=team_abc');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  test('add_project_domain POSTs /v10/projects/{id}/domains with whitelisted body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ name: 'www.example.com', verified: false }),
    );
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__add_project_domain', {
      projectId: 'prj_abc',
      name: 'www.example.com',
      gitBranch: 'main',
      // a field not in the whitelist must be dropped
      sneakyExtra: 'nope',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v10/projects/prj_abc/domains?teamId=team_abc');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ name: 'www.example.com', gitBranch: 'main' });
  });

  test('add_project_domain throws when name missing', async () => {
    const fetchImpl = vi.fn();
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'vercel__add_project_domain', {
        projectId: 'prj_abc',
      }),
    ).rejects.toThrow(/name is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('verify_project_domain POSTs /v9/projects/{id}/domains/{domain}/verify (URL-encoded)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ verified: true }),
    );
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__verify_project_domain', {
      projectId: 'prj_abc',
      domain: 'www.example.com',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.vercel.com/v9/projects/prj_abc/domains/www.example.com/verify?teamId=team_abc',
    );
    expect(init.method).toBe('POST');
  });

  test('remove_project_domain DELETEs /v9/projects/{id}/domains/{domain}', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__remove_project_domain', {
      projectId: 'prj_abc',
      domain: 'www.example.com',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.vercel.com/v9/projects/prj_abc/domains/www.example.com?teamId=team_abc',
    );
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  test('update_deployment_protection PATCHes /v9/projects/{id} with ssoProtection + passwordProtection only', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    const adapter = new VercelAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'vercel__update_deployment_protection', {
      projectId: 'prj_abc',
      ssoProtection: { deploymentType: 'all' },
      passwordProtection: null,
      // a field not in the whitelist must be dropped
      rootDirectory: 'leak',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v9/projects/prj_abc?teamId=team_abc');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      ssoProtection: { deploymentType: 'all' },
      passwordProtection: null,
    });
  });

  test('new custom tools exposed in availableTools', () => {
    const adapter = new VercelAdapter();
    const names = adapter.availableTools.map((t) => t.name);
    expect(names).toContain('vercel__list_project_domains');
    expect(names).toContain('vercel__add_project_domain');
    expect(names).toContain('vercel__verify_project_domain');
    expect(names).toContain('vercel__remove_project_domain');
    expect(names).toContain('vercel__update_deployment_protection');
  });
});
