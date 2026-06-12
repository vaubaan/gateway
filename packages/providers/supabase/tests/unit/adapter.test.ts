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

  test('execute_sql SELECT → db/rows:read @staging', () => {
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

  test('execute_sql INSERT → db/rows:write @staging (security: not read)', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: "insert into t(x) values('a');" },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'rows',
        action: 'write',
        env: 'staging',
      },
    });
  });

  test('execute_sql DROP TABLE → db/tables:write @staging (security: rises level)', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: 'drop table users;' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'tables',
        action: 'write',
        env: 'staging',
      },
    });
  });

  test('execute_sql GRANT → db/rls:write @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: 'grant select on t to anon;' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'rls',
        action: 'write',
        env: 'staging',
      },
    });
  });

  test('execute_sql ALTER SYSTEM → db/project:write @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: 'alter system set work_mem = "64MB";' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'project',
        action: 'write',
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

  test('binding with environment=null yields an env-less capability for execute_sql', () => {
    const adapter = new SupabaseAdapter();
    const envlessBinding: ProviderBinding = { ...binding, environment: null };
    const result = adapter.classify(
      'supabase__execute_sql',
      { project_ref: 'qsockrvwpfzvxxecwjvh', query: 'drop table users;' },
      [envlessBinding],
    );
    expect(result).toEqual({
      capability: { provider: 'supabase', plane: 'db', level: 'tables', action: 'write' },
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

  test('list_buckets → storage/buckets:read @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__list_buckets',
      { project_ref: 'qsockrvwpfzvxxecwjvh' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'storage',
        level: 'buckets',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('get_auth_config → auth/auth-config:read @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__get_auth_config',
      { project_ref: 'qsockrvwpfzvxxecwjvh' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'auth',
        level: 'auth-config',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('list_functions → functions/deployment:read @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__list_functions',
      { project_ref: 'qsockrvwpfzvxxecwjvh' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'functions',
        level: 'deployment',
        action: 'read',
        env: 'staging',
      },
    });
  });

  test('apply_migration → db/tables:write @staging', () => {
    const adapter = new SupabaseAdapter();
    const result = adapter.classify(
      'supabase__apply_migration',
      { project_ref: 'qsockrvwpfzvxxecwjvh', name: 'add_index', query: 'create index ...' },
      [binding],
    );
    expect(result).toEqual({
      capability: {
        provider: 'supabase',
        plane: 'db',
        level: 'tables',
        action: 'write',
        env: 'staging',
      },
    });
  });
});

describe('SupabaseAdapter — executeCall (new mgmt-api tools)', () => {
  test('list_buckets GETs /v1/projects/:ref/storage/buckets', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: 'avatars' }]));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__list_buckets', { project_ref: 'abc' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/storage/buckets');
    expect(init.method ?? 'GET').toBe('GET');
  });

  test('get_function GETs /v1/projects/:ref/functions/:slug (slug url-encoded)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ slug: 'my-fn' }));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__get_function', {
      project_ref: 'abc',
      function_slug: 'my fn/with space',
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/functions/my%20fn%2Fwith%20space');
  });

  test('get_anon_key GETs /v1/projects/:ref/api-keys and returns {url, anon_key}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        { name: 'anon', api_key: 'eyJhbGc.anon.sig' },
        { name: 'service_role', api_key: 'eyJhbGc.service_role.sig' },
      ]),
    );
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'supabase__get_anon_key', {
      project_ref: 'qsockrvwpfzvxxecwjvh',
    })) as { url: string; anon_key: string };
    expect(out).toEqual({
      url: 'https://qsockrvwpfzvxxecwjvh.supabase.co',
      anon_key: 'eyJhbGc.anon.sig',
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/qsockrvwpfzvxxecwjvh/api-keys');
  });

  test('get_anon_key throws when no anon entry is returned', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ name: 'service_role', api_key: 'sr' }]));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'supabase__get_anon_key', { project_ref: 'abc' }),
    ).rejects.toThrow(/no 'anon' entry/);
  });

  test('apply_migration POSTs /v1/projects/:ref/database/migrations with body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: '20260611' }));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__apply_migration', {
      project_ref: 'abc',
      name: 'add_index',
      query: 'create index ix on t(x);',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/database/migrations');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ name: 'add_index', query: 'create index ix on t(x);' });
  });
});
