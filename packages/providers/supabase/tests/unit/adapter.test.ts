import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
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
  environment: 'staging',
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

describe('SupabaseAdapter — classify', () => {
  test('list_tables → db/tables:read @staging (env from binding)', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__list_tables',
      { project_ref: 'qsockrvwpfzvxxecwjvh' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'tables',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('execute_sql → db/rows:read @staging (MVP read-only)', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: 'select 1;' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'rows',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('get_advisors → db/rls:read @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__get_advisors',
      { project_ref: 'qsockrvwpfzvxxecwjvh' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'rls',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('get_project → db/project:read @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__get_project',
      { project_ref: 'qsockrvwpfzvxxecwjvh' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'project',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('read with no matching binding is denied', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__get_project',
      { project_ref: 'notbound000000000000' },
      [binding],
    );
    expect(result).toEqual({
      denied: "supabase project 'notbound000000000000' is not bound to this project.",
    });
  });

  test('unknown tool is denied', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify('supabase__nope', { project_ref: 'qsockrvwpfzvxxecwjvh' }, [
      binding,
    ]);
    expect(result).toEqual({ denied: "unknown supabase tool 'supabase__nope'." });
  });

  test('binding with environment=null yields an env-less capability', () => {
    const adapter = new SupabaseAdapter();
    const envlessBinding: ProviderBinding = { ...binding, environment: null };
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: 'select 1;' },
      [envlessBinding],
    );
    expect(result).toEqual({
      capability: { provider: 'supabase', plane: 'db', level: 'rows', action: 'read' },
    });
  });
});
