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

describe('SupabaseAdapter — executeCall (new write surface)', () => {
  test('update_auth_config PATCHes /config/auth with the config body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__update_auth_config', {
      project_ref: 'abc',
      config: { site_url: 'https://app.example', jwt_exp: 3600 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/config/auth');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      site_url: 'https://app.example',
      jwt_exp: 3600,
    });
  });

  test('update_storage_config PATCHes /config/storage with the config body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__update_storage_config', {
      project_ref: 'abc',
      config: { fileSizeLimit: 1048576 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/config/storage');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ fileSizeLimit: 1048576 });
  });

  test('create_sso_provider POSTs /config/auth/sso/providers with project_ref stripped', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'uuid-x' }));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__create_sso_provider', {
      project_ref: 'abc',
      type: 'saml',
      metadata_url: 'https://idp/m.xml',
      domains: ['acme.com'],
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/config/auth/sso/providers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'saml',
      metadata_url: 'https://idp/m.xml',
      domains: ['acme.com'],
    });
  });

  test('update_sso_provider PUTs /sso/providers/:id with provider_id stripped', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__update_sso_provider', {
      project_ref: 'abc',
      provider_id: 'uuid-1',
      domains: ['x.com'],
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/config/auth/sso/providers/uuid-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ domains: ['x.com'] });
  });

  test('delete_sso_provider DELETEs /sso/providers/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(''),
    });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    const out = await adapter.executeCall(baseAdmin, binding, 'supabase__delete_sso_provider', {
      project_ref: 'abc',
      provider_id: 'uuid-1',
    });
    expect(out).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/config/auth/sso/providers/uuid-1');
    expect(init.method).toBe('DELETE');
  });

  test('create_function POSTs /functions with body, project_ref stripped', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ slug: 'hello' }));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__create_function', {
      project_ref: 'abc',
      slug: 'hello',
      body: 'export default () => "ok"',
      verify_jwt: false,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/functions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      slug: 'hello',
      body: 'export default () => "ok"',
      verify_jwt: false,
    });
  });

  test('deploy_function POSTs /functions/deploy?slug=… with body sans slug/project_ref', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: 2 }));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__deploy_function', {
      project_ref: 'abc',
      slug: 'my fn',
      entrypoint_path: 'index.ts',
      files: [{ name: 'index.ts', content: 'x' }],
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/functions/deploy?slug=my%20fn');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      entrypoint_path: 'index.ts',
      files: [{ name: 'index.ts', content: 'x' }],
    });
  });

  test('delete_function DELETEs /functions/:slug', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(''),
    });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__delete_function', {
      project_ref: 'abc',
      function_slug: 'hello',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/functions/hello');
    expect(init.method).toBe('DELETE');
  });

  test('create_function_secrets POSTs /secrets with the secrets array body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__create_function_secrets', {
      project_ref: 'abc',
      secrets: [
        { name: 'API_KEY', value: 'k1' },
        { name: 'DB_URL', value: 'postgres://...' },
      ],
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/secrets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual([
      { name: 'API_KEY', value: 'k1' },
      { name: 'DB_URL', value: 'postgres://...' },
    ]);
  });

  test('delete_function_secrets DELETEs /secrets with the names body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(''),
    });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__delete_function_secrets', {
      project_ref: 'abc',
      names: ['API_KEY', 'DB_URL'],
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/abc/secrets');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual(['API_KEY', 'DB_URL']);
  });
});

describe('SupabaseAdapter — executeCall (data plane via service_role)', () => {
  /** Mock fetch that returns service_role on the first /api-keys call, then a
   *  scripted response on the next data plane call. */
  function dataPlaneFetch(dataResponse: {
    ok?: boolean;
    status?: number;
    body?: unknown;
    contentType?: string;
  }) {
    const fetchImpl = vi.fn();
    // First call: /api-keys returns service_role.
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          { name: 'anon', api_key: 'eyJ.anon.x' },
          { name: 'service_role', api_key: 'eyJ.service_role.x' },
        ]),
      text: () => Promise.resolve('[]'),
    });
    // Second call: the actual data plane endpoint.
    const ct = dataResponse.contentType ?? 'application/json';
    fetchImpl.mockResolvedValueOnce({
      ok: dataResponse.ok ?? true,
      status: dataResponse.status ?? 200,
      headers: { get: () => ct },
      json: () => Promise.resolve(dataResponse.body ?? {}),
      text: () => Promise.resolve(JSON.stringify(dataResponse.body ?? '')),
    });
    return fetchImpl;
  }

  test('list_users GETs /auth/v1/admin/users with service_role Bearer + apikey', async () => {
    const fetchImpl = dataPlaneFetch({ body: { users: [{ id: 'u1' }] } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(baseAdmin, binding, 'supabase__list_users', {
      project_ref: 'abc',
      per_page: 25,
    })) as { users: { id: string }[] };
    expect(out.users[0]?.id).toBe('u1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call: PAT → /api-keys (Mgmt API).
    const [mgmtUrl, mgmtInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(mgmtUrl).toBe('https://api.supabase.com/v1/projects/abc/api-keys');
    expect((mgmtInit.headers as Record<string, string>).Authorization).toBe('Bearer sbp_xxx');
    // Second call: service_role → data plane.
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/auth/v1/admin/users?page=1&per_page=25');
    const headers = dpInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJ.service_role.x');
    expect(headers.apikey).toBe('eyJ.service_role.x');
  });

  test('create_user POSTs /auth/v1/admin/users with project_ref stripped', async () => {
    const fetchImpl = dataPlaneFetch({ body: { id: 'u1', email: 'a@b.c' } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__create_user', {
      project_ref: 'abc',
      email: 'a@b.c',
      password: 'secret',
      email_confirm: true,
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/auth/v1/admin/users');
    expect(dpInit.method).toBe('POST');
    expect(JSON.parse(dpInit.body as string)).toEqual({
      email: 'a@b.c',
      password: 'secret',
      email_confirm: true,
    });
  });

  test('update_user PUTs /auth/v1/admin/users/{user_id} with user_id stripped from body', async () => {
    const fetchImpl = dataPlaneFetch({ body: { id: 'u1' } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__update_user', {
      project_ref: 'abc',
      user_id: 'u1',
      app_metadata: { role: 'admin' },
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/auth/v1/admin/users/u1');
    expect(dpInit.method).toBe('PUT');
    expect(JSON.parse(dpInit.body as string)).toEqual({ app_metadata: { role: 'admin' } });
  });

  test('delete_user DELETEs /auth/v1/admin/users/{user_id}', async () => {
    const fetchImpl = dataPlaneFetch({ status: 204, body: null });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__delete_user', {
      project_ref: 'abc',
      user_id: 'u1',
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/auth/v1/admin/users/u1');
    expect(dpInit.method).toBe('DELETE');
  });

  test('generate_link POSTs /auth/v1/admin/generate_link', async () => {
    const fetchImpl = dataPlaneFetch({ body: { action_link: 'https://abc/...' } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__generate_link', {
      project_ref: 'abc',
      type: 'magiclink',
      email: 'a@b.c',
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/auth/v1/admin/generate_link');
    expect(dpInit.method).toBe('POST');
    expect(JSON.parse(dpInit.body as string)).toEqual({ type: 'magiclink', email: 'a@b.c' });
  });

  test('create_bucket POSTs /storage/v1/bucket', async () => {
    const fetchImpl = dataPlaneFetch({ body: { name: 'avatars' } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__create_bucket', {
      project_ref: 'abc',
      id: 'avatars',
      name: 'avatars',
      public: true,
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/storage/v1/bucket');
    expect(dpInit.method).toBe('POST');
    expect(JSON.parse(dpInit.body as string)).toEqual({
      id: 'avatars',
      name: 'avatars',
      public: true,
    });
  });

  test('delete_bucket DELETEs /storage/v1/bucket/{id}', async () => {
    const fetchImpl = dataPlaneFetch({ body: {} });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__delete_bucket', {
      project_ref: 'abc',
      id: 'avatars',
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/storage/v1/bucket/avatars');
    expect(dpInit.method).toBe('DELETE');
  });

  test('list_objects POSTs /storage/v1/object/list/{bucket} with prefix body', async () => {
    const fetchImpl = dataPlaneFetch({ body: [{ name: 'a.png' }] });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__list_objects', {
      project_ref: 'abc',
      bucket: 'avatars',
      prefix: 'sub/',
      limit: 10,
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/storage/v1/object/list/avatars');
    expect(dpInit.method).toBe('POST');
    expect(JSON.parse(dpInit.body as string)).toEqual({ prefix: 'sub/', limit: 10 });
  });

  test('upload_object POSTs raw bytes (base64-decoded) with Content-Type + x-upsert header', async () => {
    const fetchImpl = dataPlaneFetch({ body: { Key: 'avatars/a.png' } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__upload_object', {
      project_ref: 'abc',
      bucket: 'avatars',
      path: 'folder/a.png',
      content_base64: Buffer.from('hello').toString('base64'),
      content_type: 'image/png',
      upsert: true,
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    // Path separators preserved, segments URL-encoded.
    expect(dpUrl).toBe('https://abc.supabase.co/storage/v1/object/avatars/folder/a.png');
    expect(dpInit.method).toBe('POST');
    const headers = dpInit.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['x-upsert']).toBe('true');
    // Body is the raw Buffer (bytes) — not JSON.
    expect((dpInit.body as Buffer).toString('utf8')).toBe('hello');
  });

  test('create_signed_url POSTs /storage/v1/object/sign/{bucket}/{path} with expiresIn', async () => {
    const fetchImpl = dataPlaneFetch({ body: { signedURL: '/object/sign/...' } });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'supabase__create_signed_url', {
      project_ref: 'abc',
      bucket: 'avatars',
      path: 'folder/a.png',
      expires_in: 600,
    });
    const [dpUrl, dpInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dpUrl).toBe('https://abc.supabase.co/storage/v1/object/sign/avatars/folder/a.png');
    expect(dpInit.method).toBe('POST');
    expect(JSON.parse(dpInit.body as string)).toEqual({ expiresIn: 600 });
  });

  test('data plane throws if /api-keys returns no service_role', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ name: 'anon', api_key: 'eyJ.anon.x' }]),
      text: () => Promise.resolve('[]'),
    });
    const adapter = new SupabaseAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'supabase__list_users', { project_ref: 'abc' }),
    ).rejects.toThrow(/no 'service_role' entry/);
  });
});
