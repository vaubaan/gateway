/**
 * Mandatory suite of the `supabase` plugin : the SDK kit, the credential
 * spec, `execute` and `discoverResources` against `mockFetch`,
 * and the macro-actions. No network : an unmatched request fails the test.
 */
import { describe, expect, test } from 'vitest';

import {
  type ConnectionContext,
  type ExecuteContext,
  type ApiKeySecret,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  mockFetch,
  policyFromMacroActions,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import {
  MAX_DISCOVERED_PROJECTS,
  SUPABASE_API_BASE,
  SUPABASE_CLASSIFIED_TOOLS,
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

const tokenSecret = (overrides: Partial<ApiKeySecret> = {}): ApiKeySecret => ({
  kind: 'api-key',
  fields: { access_token: 'sbp_access' },
  metadata: { account: 'acme' },
  ...overrides,
});

const connCtx = (
  fetch: typeof globalThis.fetch,
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext => ({
  credential: tokenSecret(),
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
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(supabasePlugin);
    assertNoWildcard(supabasePlugin);
  });

  test('declares 44 tools, the same set the classifier knows', () => {
    const declared = supabasePlugin.tools.map((t) => t.name).sort();
    expect(declared).toHaveLength(44);
    expect(declared).toEqual([...SUPABASE_CLASSIFIED_TOOLS].sort());
  });

  const p = { project_ref: STAGING_REF };
  // One table for the catalog coverage and for the identifier proof.
  const SAMPLES: ToolSamples = {
    supabase__get_project: [{ args: p }, { args: {} }],
    supabase__get_anon_key: [{ args: p }],
    supabase__list_tables: [{ args: { ...p, schemas: ['public', 'app'] } }],
    supabase__list_migrations: [{ args: p }],
    supabase__execute_sql: [
      { args: { ...p, query: 'DELETE FROM users;' } },
      { args: p, expectDenied: true },
    ],
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
      { args: { ...p, name: 'grant', query: 'grant select on t to anon;' } },
      { args: { ...p, name: 'ext', query: 'create extension if not exists vector;' } },
      { args: { ...p, name: 'fn', query: 'do $$ begin null; end $$;' } },
      {
        args: { ...p, name: 'no-sql', query: ['create table x(id int);'] },
        expectDenied: true,
      },
      {
        args: { ...p, projectRef: STAGING_REF, name: 'alias', query: 'select 1;' },
        expectDenied: true,
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
    supabase__update_user: [{ args: { ...p, user_id: 'u1' } }, { args: { ...p, user_id: 'bulk' } }],
    supabase__delete_user: [
      { args: { ...p, user_id: 'u1' } },
      { args: { ...p, user_id: ['u1'] }, expectDenied: true },
    ],
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
  };

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(supabasePlugin, SAMPLES, { resources: [staging] });
    expect(report.toolsChecked).toBe(44);
    // No sample lands on the fallback : every write a tool can make has a
    // dedicated catalog entry (ADR fallback-risk-only-when-uncategorized).
    expect(report.fallbackHits).toEqual([]);
    // Every catalog risk a tool can reach today is touched. Untouched on
    // purpose : `row-write-one` (no tool writes rows one by one — execute_sql
    // is read-only) and `auth.bulk-user-write` (no bulk user tool yet).
    expect(report.risksUntouched).toEqual([
      'supabase.row-write-one',
      'supabase.auth.bulk-user-write',
    ]);
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(supabasePlugin, SAMPLES, {
      resources: [staging],
      context: (fetch, resources) => execCtx(fetch, resources),
    });
    expect(report.toolsChecked).toBe(44);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'function_slug',
      'project_ref',
      'provider_id',
      'tpa_id',
      'type',
    ]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
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
      supabasePlugin.classify('supabase__get_project', { project_ref: [PROD_REF] }, [staging]),
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
// Macro-actions
// ─────────────────────────────────────────────────────────────────────────────

describe('supabase macro-actions', () => {
  const ALL = {
    query: 'autonomous',
    'change-data': 'autonomous',
    'change-schema': 'autonomous',
    'ship-functions': 'autonomous',
    administer: 'autonomous',
  } as const;
  const isWrite = (riskId: string) =>
    supabasePlugin.catalog.risks.find((r) => r.id === riskId.replace(/\[[a-z-]+\]/, ''))!
      .matches === 'supabase.**.W' || /write|deploy|generate-link/.test(riskId);

  test('ships query, change-data, change-schema, ship-functions and administer ; the fallback in none', () => {
    const actions = supabasePlugin.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual([
      'query',
      'change-data',
      'change-schema',
      'ship-functions',
      'administer',
    ]);
    for (const a of actions) {
      expect(a.entries.map((e) => e.risk_id)).not.toContain('supabase.uncategorized-write');
    }
  });

  test('query, at any trust level and in any environment, accepts no write', () => {
    const lines = policyFromMacroActions(
      supabasePlugin,
      { query: 'autonomous' },
      { envs: ['preview', 'staging', 'prod'] },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map((l) => l.risk_id).some(isWrite)).toBe(false);
  });

  test('every write is env-scoped : a staging mission writes on staging only, never the fallback', () => {
    const lines = policyFromMacroActions(supabasePlugin, ALL, { envs: ['staging'] });
    const writes = lines.filter((l) => isWrite(l.risk_id));
    expect(writes.length).toBeGreaterThan(5);
    for (const l of writes) expect(l.risk_id.startsWith('supabase[staging].')).toBe(true);
    expect(lines.some((l) => l.risk_id.includes('[prod]'))).toBe(false);
    // Without an environment, nothing is written.
    expect(policyFromMacroActions(supabasePlugin, ALL).some((l) => isWrite(l.risk_id))).toBe(false);
  });

  test('a prod migration asks first at Careful and Trusting ; no trust level writes bulk rows on prod', () => {
    for (const trustLevel of ['careful', 'trusting'] as const) {
      const lines = policyFromMacroActions(
        supabasePlugin,
        { 'change-schema': trustLevel },
        { envs: ['prod'] },
      );
      const gate = (id: string) => lines.find((l) => l.risk_id === id)?.gate;
      expect(gate('supabase[prod].migration-write'), trustLevel).toBe('approval');
      expect(gate('supabase[prod].policy-write'), trustLevel).toBe('approval');
    }
    const lines = policyFromMacroActions(supabasePlugin, ALL, { envs: ['prod'] });
    expect(lines.map((l) => l.risk_id).filter((id) => /bulk/.test(id))).toEqual([]);
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
  test('a personal access token of the Management API, the one way of connecting', () => {
    const c = supabasePlugin.credential;
    expect(c.kind).toBe('api-key');
    if (c.kind !== 'api-key') return;
    expect(c.fields.map((f) => f.name)).toEqual(['access_token']);
    expect(c.createUrl).toBe('https://supabase.com/dashboard/account/tokens');
    expect(c.guide?.permissions.length).toBeGreaterThan(0);
    expect('refresh' in supabasePlugin).toBe(false);
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
      schemas: ['public', 'app_v2'],
    });
    await supabasePlugin.execute(ctx, 'supabase__list_migrations', { project_ref: STAGING_REF });
    expect(fetch.calls).toHaveLength(3);
    expect((fetch.calls[0]!.json as { query: string }).query).toBe('select 1');
    expect((fetch.calls[1]!.json as { query: string }).query).toContain("in ('public','app_v2')");
    expect((fetch.calls[2]!.json as { query: string }).query).toContain('schema_migrations');

    // A schema name that is not an identifier is refused, not quoted into the SQL text.
    const quoted = await supabasePlugin.execute(ctx, 'supabase__list_tables', {
      project_ref: STAGING_REF,
      schemas: ["pub'lic"],
    });
    expect(quoted.isError).toBe(true);
    expect(fetch.calls).toHaveLength(3);
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
        url: `https://${STAGING_REF}.supabase.co/storage/v1/object/avatars/dir/a-b.png`,
        body: { Key: 'avatars/dir/a-b.png' },
        times: 1,
      },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__upload_object', {
      project_ref: STAGING_REF,
      bucket: 'avatars',
      path: 'dir/a-b.png',
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
    expect(textOf(result)).toEqual({ Key: 'avatars/dir/a-b.png' });
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
    const result = await supabasePlugin.execute(execCtx(fetch), 'supabase__not_a_tool', {
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
