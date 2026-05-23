import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vauban/shared';
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

describe('VercelAdapter — resolveTarget', () => {
  test('project.vercel returns vercel bindings', () => {
    const adapter = new VercelAdapter();
    expect(
      adapter.resolveTarget('project.vercel', [
        binding,
        { ...binding, provider: 'github', resource_ref: 'acme/x' },
      ]),
    ).toEqual(['prj_abc']);
  });
});
