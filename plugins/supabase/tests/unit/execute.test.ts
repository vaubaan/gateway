/**
 * Request shapes of the `supabase` plugin : for each tool family, the method,
 * URL, headers and body `supabasePlugin.execute` sends to the Management API
 * and to the per-project data plane (GoTrue admin, Storage).
 *
 * Complements `plugin.test.ts`, which covers the credential, the read-only
 * SQL endpoint, error mapping and discovery. No network : an unmatched
 * request fails the test.
 */
import { describe, expect, test } from 'vitest';

import type { CredentialSecret, ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { SUPABASE_API_BASE, supabasePlugin } from '../../src/index.ts';
import { resultJson, resultText, sentQuery } from './support.ts';

const REF = 'tlqgxnezmthbpzhdwxgi';
const MGMT = `${SUPABASE_API_BASE}/projects/${REF}`;
const DATA = `https://${REF}.supabase.co`;

const project: Resource = {
  service: 'supabase',
  ref: REF,
  env: 'staging',
  displayName: 'Acme / app-staging',
};

const credential: CredentialSecret = {
  kind: 'api-key',
  fields: { access_token: 'sbp_access' },
  metadata: {},
};

const execCtx = (fetch: typeof globalThis.fetch): ExecuteContext => ({
  credential,
  fetch,
  resources: [project],
});

/** Run one tool against a single-route Management API mock ; returns the recorded call and the result. */
async function runMgmt(route: MockRoute, tool: string, args: Record<string, unknown>) {
  const fetch = mockFetch([{ ...route, times: 1 }]);
  const result = await supabasePlugin.execute(execCtx(fetch), tool, { project_ref: REF, ...args });
  expect(fetch.calls).toHaveLength(1);
  return { call: fetch.calls[0]!, result };
}

/** The Management API answer the data plane reads the `service_role` key from. */
const apiKeysRoute: MockRoute = {
  method: 'GET',
  url: `${MGMT}/api-keys`,
  body: [
    { name: 'anon', api_key: 'eyJ.anon.x' },
    { name: 'service_role', api_key: 'eyJ.service_role.x' },
  ],
  times: 1,
};

/** Run one data-plane tool : `/api-keys` first, then the scripted project-host route. */
async function runData(route: MockRoute, tool: string, args: Record<string, unknown>) {
  const fetch = mockFetch([apiKeysRoute, { ...route, times: 1 }]);
  const result = await supabasePlugin.execute(execCtx(fetch), tool, { project_ref: REF, ...args });
  expect(fetch.calls).toHaveLength(2);
  expect(fetch.pending()).toEqual([]);
  return { keys: fetch.calls[0]!, call: fetch.calls[1]!, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API — reads
// ─────────────────────────────────────────────────────────────────────────────

describe('executeSupabase — Management API reads', () => {
  test('list_buckets GETs /projects/:ref/storage/buckets', async () => {
    const { call, result } = await runMgmt(
      { method: 'GET', url: `${MGMT}/storage/buckets`, body: [{ id: 'avatars' }] },
      'supabase__list_buckets',
      {},
    );
    expect(call.method).toBe('GET');
    expect(resultJson(result)).toEqual([{ id: 'avatars' }]);
  });

  test('get_function GETs /projects/:ref/functions/:slug ; a slug that is not one path segment is refused, not encoded', async () => {
    const { call } = await runMgmt(
      { method: 'GET', url: /\/functions\//, body: { slug: 'my-fn' } },
      'supabase__get_function',
      { function_slug: 'my-fn' },
    );
    expect(call.url).toBe(`${MGMT}/functions/my-fn`);

    const fetch = mockFetch([]);
    const refused = await supabasePlugin.execute(execCtx(fetch), 'supabase__get_function', {
      project_ref: REF,
      function_slug: 'my fn/with space',
    });
    expect(refused.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test('get_anon_key fails when the Management API returns no anon entry', async () => {
    const fetch = mockFetch([
      { url: `${MGMT}/api-keys`, body: [{ name: 'service_role', api_key: 'sr' }] },
    ]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), 'supabase__get_anon_key', { project_ref: REF }),
    ).rejects.toThrow(/no 'anon' entry/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Management API — writes
// ─────────────────────────────────────────────────────────────────────────────

describe('executeSupabase — Management API writes', () => {
  test('update_auth_config PATCHes /config/auth with the config as body', async () => {
    const { call } = await runMgmt(
      { method: 'PATCH', url: `${MGMT}/config/auth`, body: {} },
      'supabase__update_auth_config',
      { config: { site_url: 'https://app.example', jwt_exp: 3600 } },
    );
    expect(call.json).toEqual({ site_url: 'https://app.example', jwt_exp: 3600 });
  });

  test('update_storage_config PATCHes /config/storage with the config as body', async () => {
    const { call } = await runMgmt(
      { method: 'PATCH', url: `${MGMT}/config/storage`, body: {} },
      'supabase__update_storage_config',
      { config: { fileSizeLimit: 1048576 } },
    );
    expect(call.json).toEqual({ fileSizeLimit: 1048576 });
  });

  test('create_sso_provider POSTs /config/auth/sso/providers with project_ref stripped', async () => {
    const { call } = await runMgmt(
      { method: 'POST', url: `${MGMT}/config/auth/sso/providers`, body: { id: 'uuid-x' } },
      'supabase__create_sso_provider',
      { type: 'saml', metadata_url: 'https://idp/m.xml', domains: ['acme.com'] },
    );
    expect(call.json).toEqual({
      type: 'saml',
      metadata_url: 'https://idp/m.xml',
      domains: ['acme.com'],
    });
  });

  test('update_sso_provider PUTs /sso/providers/:id with provider_id stripped', async () => {
    const { call } = await runMgmt(
      { method: 'PUT', url: `${MGMT}/config/auth/sso/providers/uuid-1`, body: {} },
      'supabase__update_sso_provider',
      { provider_id: 'uuid-1', domains: ['x.com'] },
    );
    expect(call.json).toEqual({ domains: ['x.com'] });
  });

  test('delete_sso_provider DELETEs /sso/providers/:id ; a 204 becomes an ok payload', async () => {
    const { call, result } = await runMgmt(
      { method: 'DELETE', url: `${MGMT}/config/auth/sso/providers/uuid-1`, status: 204 },
      'supabase__delete_sso_provider',
      { provider_id: 'uuid-1' },
    );
    expect(call.body).toBeNull();
    expect(resultJson(result)).toEqual({ ok: true });
  });

  test('create_function POSTs /functions with the body, project_ref stripped', async () => {
    const { call } = await runMgmt(
      { method: 'POST', url: `${MGMT}/functions`, body: { slug: 'hello' } },
      'supabase__create_function',
      { slug: 'hello', body: 'export default () => "ok"', verify_jwt: false },
    );
    expect(call.json).toEqual({
      slug: 'hello',
      body: 'export default () => "ok"',
      verify_jwt: false,
    });
  });

  test('deploy_function POSTs /functions/deploy?slug=… with the body minus slug and project_ref', async () => {
    const { call } = await runMgmt(
      { method: 'POST', url: /\/functions\/deploy/, body: { version: 2 } },
      'supabase__deploy_function',
      { slug: 'my-fn', entrypoint_path: 'index.ts', files: [{ name: 'index.ts', content: 'x' }] },
    );
    expect(call.url).toBe(`${MGMT}/functions/deploy?slug=my-fn`);
    expect(call.json).toEqual({
      entrypoint_path: 'index.ts',
      files: [{ name: 'index.ts', content: 'x' }],
    });
  });

  test('delete_function DELETEs /functions/:slug', async () => {
    const { call } = await runMgmt(
      { method: 'DELETE', url: `${MGMT}/functions/hello`, status: 204 },
      'supabase__delete_function',
      { function_slug: 'hello' },
    );
    expect(call.method).toBe('DELETE');
  });

  test('create_function_secrets POSTs /secrets with the secrets array as body', async () => {
    const secrets = [
      { name: 'API_KEY', value: 'k1' },
      { name: 'DB_URL', value: 'postgres://...' },
    ];
    const { call } = await runMgmt(
      { method: 'POST', url: `${MGMT}/secrets`, body: {} },
      'supabase__create_function_secrets',
      { secrets },
    );
    expect(call.json).toEqual(secrets);
  });

  test('delete_function_secrets DELETEs /secrets with the names as body', async () => {
    const { call } = await runMgmt(
      { method: 'DELETE', url: `${MGMT}/secrets`, status: 204 },
      'supabase__delete_function_secrets',
      { names: ['API_KEY', 'DB_URL'] },
    );
    expect(call.json).toEqual(['API_KEY', 'DB_URL']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Data plane — `{ref}.supabase.co` with the service_role key
// ─────────────────────────────────────────────────────────────────────────────

describe('executeSupabase — data plane through service_role', () => {
  test('list_users GETs /auth/v1/admin/users with the service_role as bearer and apikey', async () => {
    const { keys, call, result } = await runData(
      { method: 'GET', url: /\/auth\/v1\/admin\/users/, body: { users: [{ id: 'u1' }] } },
      'supabase__list_users',
      { per_page: 25 },
    );
    // First call : the account's access token against the Management API.
    expect(keys.headers.authorization).toBe('Bearer sbp_access');
    // Second call : the service_role key against the project host.
    expect(call.url).toBe(`${DATA}/auth/v1/admin/users?page=1&per_page=25`);
    expect(call.headers.authorization).toBe('Bearer eyJ.service_role.x');
    expect(call.headers.apikey).toBe('eyJ.service_role.x');
    expect(resultJson(result)).toEqual({ users: [{ id: 'u1' }] });
  });

  test('create_user POSTs /auth/v1/admin/users with project_ref stripped', async () => {
    const { call } = await runData(
      { method: 'POST', url: `${DATA}/auth/v1/admin/users`, body: { id: 'u1', email: 'a@b.c' } },
      'supabase__create_user',
      { email: 'a@b.c', password: 'secret', email_confirm: true },
    );
    expect(call.json).toEqual({ email: 'a@b.c', password: 'secret', email_confirm: true });
  });

  test('update_user PUTs /auth/v1/admin/users/:id with user_id stripped from the body', async () => {
    const { call } = await runData(
      { method: 'PUT', url: `${DATA}/auth/v1/admin/users/u1`, body: { id: 'u1' } },
      'supabase__update_user',
      { user_id: 'u1', app_metadata: { role: 'admin' } },
    );
    expect(call.json).toEqual({ app_metadata: { role: 'admin' } });
  });

  test('delete_user DELETEs /auth/v1/admin/users/:id ; a 204 becomes an ok payload', async () => {
    const { call, result } = await runData(
      { method: 'DELETE', url: `${DATA}/auth/v1/admin/users/u1`, status: 204 },
      'supabase__delete_user',
      { user_id: 'u1' },
    );
    expect(call.method).toBe('DELETE');
    expect(resultJson(result)).toEqual({ ok: true });
  });

  test('generate_link POSTs /auth/v1/admin/generate_link', async () => {
    const { call } = await runData(
      {
        method: 'POST',
        url: `${DATA}/auth/v1/admin/generate_link`,
        body: { action_link: 'https://abc/...' },
      },
      'supabase__generate_link',
      { type: 'magiclink', email: 'a@b.c' },
    );
    expect(call.json).toEqual({ type: 'magiclink', email: 'a@b.c' });
  });

  test('create_bucket POSTs /storage/v1/bucket', async () => {
    const { call } = await runData(
      { method: 'POST', url: `${DATA}/storage/v1/bucket`, body: { name: 'avatars' } },
      'supabase__create_bucket',
      { id: 'avatars', name: 'avatars', public: true },
    );
    expect(call.json).toEqual({ id: 'avatars', name: 'avatars', public: true });
  });

  test('delete_bucket DELETEs /storage/v1/bucket/:id', async () => {
    const { call } = await runData(
      { method: 'DELETE', url: `${DATA}/storage/v1/bucket/avatars`, body: {} },
      'supabase__delete_bucket',
      { id: 'avatars' },
    );
    expect(call.method).toBe('DELETE');
  });

  test('list_objects POSTs /storage/v1/object/list/:bucket with the prefix body', async () => {
    const { call } = await runData(
      { method: 'POST', url: `${DATA}/storage/v1/object/list/avatars`, body: [{ name: 'a.png' }] },
      'supabase__list_objects',
      { bucket: 'avatars', prefix: 'sub/', limit: 10 },
    );
    expect(call.json).toEqual({ prefix: 'sub/', limit: 10 });
  });

  test('create_signed_url POSTs /storage/v1/object/sign/:bucket/:path with expiresIn', async () => {
    const { call } = await runData(
      {
        method: 'POST',
        url: `${DATA}/storage/v1/object/sign/avatars/folder/a.png`,
        body: { signedURL: '/object/sign/...' },
      },
      'supabase__create_signed_url',
      { bucket: 'avatars', path: 'folder/a.png', expires_in: 600 },
    );
    expect(call.json).toEqual({ expiresIn: 600 });
  });

  test('fails before touching the project host when /api-keys returns no service_role', async () => {
    const fetch = mockFetch([
      { url: `${MGMT}/api-keys`, body: [{ name: 'anon', api_key: 'eyJ.anon.x' }] },
    ]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), 'supabase__list_users', { project_ref: REF }),
    ).rejects.toThrow(/no 'service_role' entry/);
    expect(fetch.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Target project — the one the classifier resolved, or no call at all
// ─────────────────────────────────────────────────────────────────────────────

describe('executeSupabase — the target project is resolved like the classifier resolves it', () => {
  const OTHER_REF = 'victimprojectrefxxxx';
  const other: Resource = { ...project, ref: OTHER_REF, displayName: 'Acme / other' };

  test('without project_ref, the single project of the mission is called (Management API)', async () => {
    const fetch = mockFetch([{ method: 'GET', url: MGMT, body: { name: 'app' }, times: 1 }]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__get_project', {});
    expect(fetch.calls.map((c) => c.url)).toEqual([`${SUPABASE_API_BASE}/projects/${REF}`]);
    expect(resultJson(result)).toEqual({ name: 'app' });
  });

  test('without project_ref, the single project of the mission is called (data plane)', async () => {
    const fetch = mockFetch([
      apiKeysRoute,
      { method: 'DELETE', url: `${DATA}/auth/v1/admin/users/u1`, status: 204, times: 1 },
    ]);
    await supabasePlugin.execute(execCtx(fetch), 'supabase__delete_user', { user_id: 'u1' });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${MGMT}/api-keys`,
      `${DATA}/auth/v1/admin/users/u1`,
    ]);
  });

  test.each<[string, Record<string, unknown>]>([
    ['a project outside the mission', { project_ref: OTHER_REF }],
    [
      'an array project_ref next to the projectRef alias',
      { project_ref: [OTHER_REF], projectRef: REF },
    ],
    ['an object project_ref', { project_ref: { toString: () => OTHER_REF } }],
    ['the projectRef alias alone', { projectRef: REF }],
    ['a path-unsafe project_ref', { project_ref: `${REF}/../${OTHER_REF}` }],
  ])('%s is an error result and no request leaves', async (_label, target) => {
    for (const [tool, args] of [
      ['supabase__apply_migration', { name: 'm', query: 'create table t (id int);' }],
      ['supabase__get_project', {}],
      ['supabase__delete_user', { user_id: 'u1' }],
      ['supabase__upload_object', { bucket: 'b', path: 'p.txt', content_base64: 'AA' }],
    ] as const) {
      const fetch = mockFetch([]);
      const result = await supabasePlugin.execute(execCtx(fetch), tool, { ...args, ...target });
      expect(result.isError, `${tool} should be refused`).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('several projects and no project_ref is an error result, not a guess', async () => {
    const fetch = mockFetch([]);
    const ctx: ExecuteContext = { ...execCtx(fetch), resources: [project, other] };
    const result = await supabasePlugin.execute(ctx, 'supabase__get_project', {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('ambiguous supabase target: specify project_ref.');
    expect(fetch.calls).toHaveLength(0);
  });

  test('with several projects, the named one is called', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${SUPABASE_API_BASE}/projects/${OTHER_REF}`, body: {}, times: 1 },
    ]);
    const ctx: ExecuteContext = { ...execCtx(fetch), resources: [project, other] };
    await supabasePlugin.execute(ctx, 'supabase__get_project', { project_ref: OTHER_REF });
    expect(fetch.pending()).toEqual([]);
  });

  test('the refusal names the same reason the classifier gives', async () => {
    const fetch = mockFetch([]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__get_project', {
      project_ref: OTHER_REF,
    });
    expect(resultText(result)).toBe(
      `supabase project '${OTHER_REF}' is not a resource of this mission.`,
    );
  });

  test('a non-string query never reaches the SQL endpoints', async () => {
    for (const tool of ['supabase__execute_sql', 'supabase__apply_migration']) {
      const fetch = mockFetch([]);
      const result = await supabasePlugin.execute(execCtx(fetch), tool, {
        project_ref: REF,
        name: 'm',
        query: ['select 1'],
      });
      expect(result.isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('list_tables refuses schema names that are not strings : none is dropped silently', async () => {
    const fetch = mockFetch([]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__list_tables', {
      project_ref: REF,
      schemas: ['app', 7, null, { a: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('schemas: missing or malformed.');
    expect(fetch.calls).toHaveLength(0);

    const { call } = await runMgmt(
      { method: 'POST', url: `${MGMT}/database/query/read-only`, body: [] },
      'supabase__list_tables',
      { schemas: ['app'] },
    );
    expect(sentQuery(call)).toContain("in ('app')");
  });
});

describe('executeSupabase — the body is built from declared arguments only', () => {
  const refusal = (tool: string, name: string): string =>
    `${name}: not an argument of '${tool}' — nothing classifies it, so it is not sent.`;

  test.each<[string, Record<string, unknown>, string]>([
    // Real fields of the service's API that no rule of the classifier reads.
    [
      'supabase__deploy_function',
      { slug: 'api', entrypoint_path: 'index.ts', static_patterns: ['*'] },
      'static_patterns',
    ],
    ['supabase__create_user', { email: 'a@example.com', password_hash: 'x' }, 'password_hash'],
    [
      'supabase__update_user',
      { user_id: '6f1c2a3e-9b7d-4c5a-8e21-0d3f4a5b6c7d', role: 'service_role' },
      'role',
    ],
    ['supabase__create_bucket', { id: 'avatars', owner: 'x' }, 'owner'],
    ['supabase__execute_sql', { query: 'select 1', read_only: false }, 'read_only'],
  ])('%s %j is refused, and nothing is sent', async (tool, args, name) => {
    const fetch = mockFetch([]);
    const result = await supabasePlugin.execute(execCtx(fetch), tool, {
      project_ref: REF,
      ...args,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(refusal(tool, name));
    expect(fetch.calls).toHaveLength(0);
  });

  test('upload_object without content, or with content that is not base64 text, is refused before any request', async () => {
    for (const content_base64 of [
      undefined,
      null,
      42,
      { toString: () => 'AA==' },
      ['AA=='],
      'not base64!',
      'A',
    ]) {
      const fetch = mockFetch([]);
      const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__upload_object', {
        project_ref: REF,
        bucket: 'avatars',
        path: 'logo.png',
        upsert: true,
        content_base64,
      });
      expect(result.isError, String(content_base64)).toBe(true);
      expect(resultText(result)).toContain('content_base64: missing or malformed.');
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('upload_object sends the decoded bytes of a base64 text, padded or not, empty included', async () => {
    for (const [content_base64, bytes] of [
      ['aGVsbG8=', 'hello'],
      ['aGVsbG8', 'hello'],
      ['', ''],
    ] as const) {
      const { call } = await runData(
        {
          method: 'POST',
          url: /\/storage\/v1\/object\/avatars\/logo\.png$/,
          body: { Key: 'avatars/logo.png' },
        },
        'supabase__upload_object',
        { bucket: 'avatars', path: 'logo.png', content_base64 },
      );
      expect(call.body ?? '').toBe(bytes);
    }
  });
});
