/**
 * Mandatory suite of the `supabase` plugin : the SDK kit, the credential
 * spec, `execute` and `discoverResources` against `mockFetch`,
 * and the presets. No network : an unmatched request fails the test.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialKindMismatch,
  type ConnectionContext,
  type ExecuteContext,
  type OAuth2Secret,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';

import {
  MAX_DISCOVERED_PROJECTS,
  SUPABASE_API_BASE,
  SUPABASE_CLASSIFIED_TOOLS,
  SUPABASE_OAUTH_TOKEN_URL,
  supabasePlugin,
} from '../../src/index.ts';

const STAGING_REF = 'tlqgxnezmthbpzhdwxgi';
const PROD_REF = 'prodxxxxxxxxxxxxxxxx';

const staging: Resource = {
  provider: 'supabase',
  ref: STAGING_REF,
  env: 'staging',
  displayName: 'Acme / app-staging',
};
const prod: Resource = {
  provider: 'supabase',
  ref: PROD_REF,
  env: 'prod',
  displayName: 'Acme / app',
};

const oauthSecret = (overrides: Partial<OAuth2Secret> = {}): OAuth2Secret => ({
  kind: 'oauth2',
  accessToken: 'sbp_access',
  refreshToken: 'sbp_refresh',
  expiresAt: '2026-10-13T12:00:00.000Z',
  scopes: ['all'],
  metadata: { account: 'acme' },
  ...overrides,
});

const connCtx = (
  fetch: typeof globalThis.fetch,
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext => ({
  credential: oauthSecret(),
  appConfig: { client_id: 'cid', client_secret: 'csecret' },
  fetch,
  ...overrides,
});

const execCtx = (fetch: typeof globalThis.fetch, resources: readonly Resource[] = [staging]) =>
  ({ ...connCtx(fetch), resources }) satisfies ExecuteContext;

const textOf = (result: { content: readonly unknown[] }) =>
  JSON.parse((result.content[0] as { text: string }).text) as unknown;

// ─────────────────────────────────────────────────────────────────────────────
// Structural kit
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(supabasePlugin);
    assertPresetsValid(supabasePlugin);
    assertNoWildcard(supabasePlugin);
  });

  test('declares 44 tools, the same set the classifier knows ; no venv tool', () => {
    const declared = supabasePlugin.tools.map((t) => t.name).sort();
    expect(declared).toHaveLength(44);
    expect(declared).toEqual([...SUPABASE_CLASSIFIED_TOOLS].sort());
    expect(declared.some((n) => n.endsWith('_to_venv'))).toBe(false);
  });

  test('every tool classifies to slices the catalog covers', () => {
    const p = { project_ref: STAGING_REF };
    const report = assertCatalogCoverage(
      supabasePlugin,
      {
        supabase__get_project: [{ args: p }, { args: {} }],
        supabase__get_anon_key: [{ args: p }],
        supabase__list_tables: [{ args: { ...p, schemas: ['public', 'app'] } }],
        supabase__list_migrations: [{ args: p }],
        supabase__execute_sql: [{ args: { ...p, query: 'DELETE FROM users;' } }],
        supabase__get_advisors: [{ args: { ...p, type: 'security' } }],
        supabase__apply_migration: [
          { args: { ...p, name: 'ddl', query: 'CREATE TABLE x(id int);' } },
          {
            args: {
              ...p,
              name: 'rls',
              query: 'CREATE POLICY p ON users USING (true); UPDATE users SET a = 1;',
            },
          },
        ],
        supabase__list_buckets: [{ args: p }],
        supabase__get_storage_config: [{ args: p }],
        supabase__update_storage_config: [{ args: { ...p, config: {} } }],
        supabase__create_bucket: [
          { args: { ...p, id: 'b1', name: 'B1' } },
          { args: { ...p, name: 'has space' }, expectDenied: true },
        ],
        supabase__update_bucket: [{ args: { ...p, id: 'b1' } }, { args: p, expectDenied: true }],
        supabase__delete_bucket: [{ args: { ...p, id: 'b1' } }],
        supabase__list_objects: [{ args: { ...p, bucket: 'b1' } }],
        supabase__upload_object: [
          { args: { ...p, bucket: 'b1', path: 'dir/p.txt', content_base64: 'AA' } },
          { args: { ...p, bucket: 'b1', content_base64: 'AA' }, expectDenied: true },
        ],
        supabase__delete_object: [{ args: { ...p, bucket: 'b1', path: 'p.txt' } }],
        supabase__create_signed_url: [{ args: { ...p, bucket: 'b1', path: 'p.txt' } }],
        supabase__get_auth_config: [{ args: p }],
        supabase__update_auth_config: [{ args: { ...p, config: {} } }],
        supabase__list_sso_providers: [{ args: p }],
        supabase__get_sso_provider: [{ args: { ...p, provider_id: 'sso1' } }],
        supabase__create_sso_provider: [
          { args: { ...p, type: 'saml' } },
          { args: p, expectDenied: true },
        ],
        supabase__update_sso_provider: [{ args: { ...p, provider_id: 'sso1' } }],
        supabase__delete_sso_provider: [{ args: { ...p, provider_id: 'sso1' } }],
        supabase__list_third_party_auth: [{ args: p }],
        supabase__get_third_party_auth: [{ args: { ...p, tpa_id: 't1' } }],
        supabase__create_third_party_auth: [{ args: { ...p, type: 'oidc' } }],
        supabase__delete_third_party_auth: [{ args: { ...p, tpa_id: 't1' } }],
        supabase__list_users: [{ args: p }],
        supabase__get_user: [{ args: { ...p, user_id: 'u1' } }, { args: p, expectDenied: true }],
        supabase__create_user: [
          { args: { ...p, email: 'a@b.c' } },
          { args: { ...p, phone: '+33612345678' } },
          { args: p },
        ],
        supabase__update_user: [{ args: { ...p, user_id: 'u1' } }],
        supabase__delete_user: [{ args: { ...p, user_id: 'u1' } }],
        supabase__generate_link: [
          { args: { ...p, email: 'a@b.c', type: 'magiclink' } },
          { args: { ...p, email: 'a b', type: 'magiclink' }, expectDenied: true },
        ],
        supabase__list_functions: [{ args: p }],
        supabase__get_function: [{ args: { ...p, function_slug: 'fn1' } }],
        supabase__get_function_body: [{ args: { ...p, function_slug: 'fn1' } }],
        supabase__list_function_secrets: [{ args: p }],
        supabase__create_function: [{ args: { ...p, slug: 'fn1', body: 'x' } }],
        supabase__update_function: [{ args: { ...p, function_slug: 'fn1' } }],
        supabase__delete_function: [{ args: { ...p, function_slug: 'fn1' } }],
        supabase__deploy_function: [
          {
            args: {
              ...p,
              slug: 'fn1',
              entrypoint_path: 'index.ts',
              files: [{ name: 'i', content: 'x' }],
            },
          },
          { args: { ...p, slug: 'fn1', entrypoint_path: 'index.ts', files: [] } },
        ],
        supabase__create_function_secrets: [
          { args: { ...p, secrets: [{ name: 'K', value: 'v' }] } },
          { args: { ...p, secrets: [] }, expectDenied: true },
          { args: { ...p, secrets: [{ name: 'bad name', value: 'v' }] }, expectDenied: true },
        ],
        supabase__delete_function_secrets: [
          { args: { ...p, names: ['K'] } },
          { args: { ...p, names: [] }, expectDenied: true },
        ],
      },
      { resources: [staging] },
    );
    expect(report.toolsChecked).toBe(44);
    // Every catalog risk a tool can reach today is touched. Untouched on
    // purpose : `row-write-one` (no tool writes rows one by one — execute_sql
    // is read-only) and the three anticipated entries without a tool yet.
    expect(report.risksUntouched).toEqual([
      'supabase.row-write-one',
      'supabase.db-role-write',
      'supabase.extension-write',
      'supabase.auth.bulk-user-write',
    ]);
  });

  test('project ref resolution : explicit must be a mission resource, single resource is the default', () => {
    expect(
      supabasePlugin.classify('supabase__get_project', { project_ref: PROD_REF }, [staging]),
    ).toEqual({
      denied: `supabase project '${PROD_REF}' is not a resource of this mission.`,
    });
    expect(supabasePlugin.classify('supabase__get_project', {}, [staging, prod])).toEqual({
      denied: 'ambiguous supabase target: specify project_ref.',
    });
    expect(
      supabasePlugin.classify('supabase__get_project', { project_ref: 'a b' }, [staging]),
    ).toEqual({
      denied: 'project_ref: missing or malformed.',
    });
    expect(
      supabasePlugin.classify('supabase__nope', { project_ref: STAGING_REF }, [staging]),
    ).toEqual({
      denied: "unknown supabase tool 'supabase__nope'.",
    });
    const ok = supabasePlugin.classify('supabase__get_project', {}, [prod]);
    expect('slices' in ok && ok.slices[0]!.path[1]).toEqual({ kind: 'ident', value: PROD_REF });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase presets', () => {
  const preset = (id: string) => {
    const p = supabasePlugin.catalog.presets?.find((x) => x.id === id);
    if (!p) throw new Error(`preset ${id} missing`);
    return p;
  };
  const isWrite = (riskId: string) =>
    supabasePlugin.catalog.risks.find((r) => r.id === riskId.replace(/\[[a-z-]+\]/, ''))!
      .matches === 'supabase.**.W' || /write|deploy|generate-link/.test(riskId);

  test('ships read-only-analyst, staging-developer and migration-operator', () => {
    expect(supabasePlugin.catalog.presets?.map((p) => p.id)).toEqual([
      'read-only-analyst',
      'staging-developer',
      'migration-operator',
    ]);
  });

  test('read-only-analyst accepts no write and no PII user listing', () => {
    const ids = preset('read-only-analyst').entries.map((e) => e.risk_id);
    expect(ids.some(isWrite)).toBe(false);
    expect(ids).not.toContain('supabase.auth.read-users');
  });

  test('staging-developer writes only on staging, never carries the fallback, never touches prod', () => {
    const entries = preset('staging-developer').entries;
    const writes = entries.filter((e) => isWrite(e.risk_id));
    expect(writes.length).toBeGreaterThan(5);
    for (const e of writes) expect(e.risk_id.startsWith('supabase[staging].')).toBe(true);
    expect(entries.some((e) => e.risk_id.includes('uncategorized-write'))).toBe(false);
    expect(entries.some((e) => e.risk_id.includes('[prod]'))).toBe(false);
    expect(entries.every((e) => e.gate === 'auto')).toBe(true);
  });

  test('migration-operator gates every prod entry on approval and keeps bulk writes off prod', () => {
    const entries = preset('migration-operator').entries;
    const prodEntries = entries.filter((e) => e.risk_id.includes('[prod]'));
    expect(prodEntries.map((e) => e.risk_id)).toEqual([
      'supabase[prod].migration-write',
      'supabase[prod].policy-write',
    ]);
    expect(entries.some((e) => e.risk_id.includes('uncategorized-write'))).toBe(false);
    for (const e of prodEntries) expect(e.gate).toBe('approval');
    expect(entries.some((e) => e.risk_id === 'supabase[prod].bulk-row-write')).toBe(false);
  });

  test('bulk risks are structurally not grantable on prod', () => {
    for (const id of [
      'supabase.bulk-row-write',
      'supabase.storage.bulk-object-write',
      'supabase.auth.bulk-user-write',
    ]) {
      const risk = supabasePlugin.catalog.risks.find((r) => r.id === id)!;
      expect(risk.acceptable_in_envs).toEqual(['preview', 'staging']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential spec
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase credential', () => {
  test('oauth2 against the Management API, PKCE, Basic client auth, refreshable', () => {
    const c = supabasePlugin.credential;
    expect(c.kind).toBe('oauth2');
    if (c.kind !== 'oauth2') return;
    expect(c.authorizationUrl).toBe('https://api.supabase.com/v1/oauth/authorize');
    expect(c.tokenUrl).toBe(SUPABASE_OAUTH_TOKEN_URL);
    expect(c.scopes).toEqual(['all']);
    expect(c.pkce).toBe(true);
    expect(c.clientAuthMethod).toBe('client_secret_basic');
    expect(c.refreshable).toBe(true);
    // Supabase's refresh is the standard refresh_token grant : no plugin
    // override, the host performs it from the spec.
    expect('refresh' in supabasePlugin).toBe(false);
  });

  test('a credential of another kind is refused before any call', async () => {
    const never = mockFetch([]);
    const ctx = execCtx(never);
    const wrong = {
      ...ctx,
      credential: { kind: 'api-key' as const, fields: { api_key: 'k' }, metadata: {} },
    };
    await expect(
      supabasePlugin.execute(wrong, 'supabase__get_project', { project_ref: STAGING_REF }),
    ).rejects.toBeInstanceOf(CredentialKindMismatch);
    expect(never.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute
// ─────────────────────────────────────────────────────────────────────────────

describe('executeSupabase with mockFetch', () => {
  test('sends the access token as bearer and returns the payload as text', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${SUPABASE_API_BASE}/projects/${STAGING_REF}`, body: { name: 'app' } },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__get_project', {
      project_ref: STAGING_REF,
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toEqual({ name: 'app' });
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer sbp_access');
  });

  test('execute_sql, list_tables and list_migrations use the read-only query endpoint', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${SUPABASE_API_BASE}/projects/${STAGING_REF}/database/query/read-only`,
        respond: (c) => [{ echoed: (c.json as { query: string }).query }],
      },
    ]);
    const ctx = execCtx(fetch);
    await supabasePlugin.execute(ctx, 'supabase__execute_sql', {
      project_ref: STAGING_REF,
      query: 'select 1',
    });
    await supabasePlugin.execute(ctx, 'supabase__list_tables', {
      project_ref: STAGING_REF,
      schemas: ["pub'lic"],
    });
    await supabasePlugin.execute(ctx, 'supabase__list_migrations', { project_ref: STAGING_REF });
    expect(fetch.calls).toHaveLength(3);
    expect((fetch.calls[0]!.json as { query: string }).query).toBe('select 1');
    expect((fetch.calls[1]!.json as { query: string }).query).toContain("in ('pub''lic')");
    expect((fetch.calls[2]!.json as { query: string }).query).toContain('schema_migrations');
  });

  test('apply_migration posts name and query ; 204 answers become an ok payload', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${SUPABASE_API_BASE}/projects/${STAGING_REF}/database/migrations`,
        status: 204,
      },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__apply_migration', {
      project_ref: STAGING_REF,
      name: 'add_index',
      query: 'create index ix on t(x);',
    });
    expect(fetch.calls[0]!.json).toEqual({ name: 'add_index', query: 'create index ix on t(x);' });
    expect(textOf(result)).toEqual({ ok: true });
  });

  test('get_anon_key returns the project URL and the anon key only', async () => {
    const fetch = mockFetch([
      {
        url: `${SUPABASE_API_BASE}/projects/${STAGING_REF}/api-keys`,
        body: [
          { name: 'anon', api_key: 'anon.jwt' },
          { name: 'service_role', api_key: 'sr.jwt' },
        ],
      },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__get_anon_key', {
      project_ref: STAGING_REF,
    });
    expect(textOf(result)).toEqual({
      url: `https://${STAGING_REF}.supabase.co`,
      anon_key: 'anon.jwt',
    });
    expect(JSON.stringify(result)).not.toContain('sr.jwt');
  });

  test('data-plane tools fetch service_role once, then call the project host with it', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${SUPABASE_API_BASE}/projects/${STAGING_REF}/api-keys`,
        body: [{ name: 'service_role', api_key: 'sr.jwt' }],
        times: 1,
      },
      {
        method: 'POST',
        url: `https://${STAGING_REF}.supabase.co/storage/v1/object/avatars/dir/a%20b.png`,
        body: { Key: 'avatars/dir/a b.png' },
        times: 1,
      },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__upload_object', {
      project_ref: STAGING_REF,
      bucket: 'avatars',
      path: 'dir/a b.png',
      content_base64: Buffer.from('hello').toString('base64'),
      content_type: 'image/png',
      upsert: true,
    });
    expect(fetch.calls).toHaveLength(2);
    const upload = fetch.calls[1]!;
    expect(upload.headers.authorization).toBe('Bearer sr.jwt');
    expect(upload.headers.apikey).toBe('sr.jwt');
    expect(upload.headers['content-type']).toBe('image/png');
    expect(upload.headers['x-upsert']).toBe('true');
    expect(upload.body).toBe('hello');
    expect(textOf(result)).toEqual({ Key: 'avatars/dir/a b.png' });
    expect(fetch.pending()).toEqual([]);
  });

  test('401 from the Management API becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: /\/projects\//, status: 401, body: { message: 'nope' } }]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), 'supabase__list_functions', {
        project_ref: STAGING_REF,
      }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 401 });
  });

  test('an undeclared tool is an error result, not a call', async () => {
    const fetch = mockFetch([]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__url_to_venv', {
      project_ref: STAGING_REF,
    });
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test('forwards the abort signal to fetch', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      seen = init?.signal;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await supabasePlugin.execute(
      { ...execCtx(fetch), signal: controller.signal },
      'supabase__get_project',
      { project_ref: STAGING_REF },
    );
    expect(seen).toBe(controller.signal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverResources
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverSupabaseResources', () => {
  test('one resource per project, named after its organization, with non-secret metadata', async () => {
    const fetch = mockFetch([
      {
        url: `${SUPABASE_API_BASE}/organizations`,
        body: [
          { id: 'org-1', slug: 'acme', name: 'Acme' },
          { id: 'org-2', slug: 'side', name: 'Side project' },
        ],
      },
      {
        url: `${SUPABASE_API_BASE}/projects`,
        body: [
          {
            id: STAGING_REF,
            name: 'app-staging',
            organization_id: 'org-1',
            region: 'eu-west-1',
            status: 'ACTIVE_HEALTHY',
          },
          { ref: PROD_REF, name: 'app', organization_slug: 'side', region: 'eu-west-1' },
          { name: 'no-ref-is-skipped' },
        ],
      },
    ]);
    const resources = await supabasePlugin.discoverResources(connCtx(fetch));
    expect(resources).toEqual([
      {
        provider: 'supabase',
        ref: STAGING_REF,
        displayName: 'Acme / app-staging',
        metadata: {
          organization: 'org-1',
          organization_name: 'Acme',
          region: 'eu-west-1',
          status: 'ACTIVE_HEALTHY',
        },
      },
      {
        provider: 'supabase',
        ref: PROD_REF,
        displayName: 'Side project / app',
        metadata: { organization: 'side', organization_name: 'Side project', region: 'eu-west-1' },
      },
    ]);
    // No `env` : the owner labels it later.
    expect(resources.every((r) => r.env === undefined)).toBe(true);
    for (const call of fetch.calls) expect(call.headers.authorization).toBe('Bearer sbp_access');
  });

  test('caps the list and warns through the logger', async () => {
    const many = Array.from({ length: MAX_DISCOVERED_PROJECTS + 5 }, (_, k) => ({
      ref: `p${String(k).padStart(19, '0')}`,
      name: `p${k}`,
    }));
    const fetch = mockFetch([
      { url: `${SUPABASE_API_BASE}/organizations`, body: [] },
      { url: `${SUPABASE_API_BASE}/projects`, body: many },
    ]);
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
    };
    const resources = await supabasePlugin.discoverResources(connCtx(fetch, { logger }));
    expect(resources).toHaveLength(MAX_DISCOVERED_PROJECTS);
    expect(resources[0]!.displayName).toBe('p0');
    expect(warnings).toHaveLength(1);
  });

  test('403 on discovery becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ url: /api\.supabase\.com/, status: 403, body: {} }]);
    await expect(supabasePlugin.discoverResources(connCtx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
  });
});
