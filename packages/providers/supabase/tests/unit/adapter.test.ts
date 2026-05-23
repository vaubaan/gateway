import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vauban/shared';
import { SupabaseAdapter } from '../../src/supabase-adapter.ts';

const baseAdmin: ProviderAdmin = {
  id: 'pa-s',
  organization_id: 'org-1',
  provider: 'supabase',
  status: 'connected',
  installation_id: null,
  team_id: null,
  access_token_encrypted: new TextEncoder().encode('sbp_xxx'),
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'supabase',
  resource_ref: 'qsockrvwpfzvxxecwjvh',
  display_name: null,
  created_at: '2026-01-01',
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('SupabaseAdapter — mintUpstreamToken', () => {
  test('returns access_token_encrypted as bearer', async () => {
    const adapter = new SupabaseAdapter();
    const { token } = await adapter.mintUpstreamToken(baseAdmin);
    expect(token).toBe('sbp_xxx');
  });
});

describe('SupabaseAdapter — executeCall', () => {
  test('supabase__get_project hits /v1/projects/:ref', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'qsockrvwpfzvxxecwjvh', name: 'test1' }));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'supabase__get_project', {
      project_ref: 'qsockrvwpfzvxxecwjvh',
    })) as { name: string };
    expect(out.name).toBe('test1');
    const url = String((fetchImpl.mock.calls[0] as [string, RequestInit])[0]);
    expect(url).toBe('https://api.supabase.com/v1/projects/qsockrvwpfzvxxecwjvh');
  });

  test('supabase__execute_sql POSTs to /database/query', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ count: 5 }]));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__execute_sql', {
      project_ref: 'abc',
      query: 'select 1;',
    });
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/projects/abc/database/query');
    expect(call[1].method).toBe('POST');
  });

  test('unknown tool throws', async () => {
    const fetchImpl = vi.fn();
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await expect(adapter.executeCall(baseAdmin, binding, 'supabase__nope', {})).rejects.toThrow(
      /Unknown/,
    );
  });
});

describe('SupabaseAdapter — resolveTarget', () => {
  test('project.supabase returns supabase bindings', () => {
    const adapter = new SupabaseAdapter();
    expect(adapter.resolveTarget('project.supabase', [binding])).toEqual(['qsockrvwpfzvxxecwjvh']);
  });
});
