/**
 * Unit tests for the Phase 6 wave B REST endpoints:
 *   - POST   /orgs/:orgId/resources/:adminId/provision        (spec §6.5)
 *   - DELETE /orgs/:orgId/resources/:rId/destroy-cloud-resource (spec §6.5)
 *
 * The Supabase client is faked with an in-memory store. We assert:
 *   - is_admin / kindClass='org-admin' gates on the parent.
 *   - childKind must live in admin.manages.
 *   - no cleartext credential is ever in the request bodies or
 *     audit_log rows (ZK invariant, spec §4).
 *
 * Spec docs/spec/cloud-resource-manager.md §6.5, §7.3.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface OrgRow {
  readonly id: string;
  readonly slug: string;
}
interface SmRow {
  readonly id: string;
  readonly organization_id: string;
  readonly is_default: boolean;
}
interface ResRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  admin_resource_id: string | null;
  provider_name: string;
  kind: string;
  scope: 'org' | 'project';
  is_admin: boolean;
  name: string;
  variant: string | null;
  provider_ref: string | null;
  console_url: string | null;
  setup_docs_url: string | null;
  health_test_cmd: string | null;
  status: string;
  secret_manager_id: string;
  provider_metadata: Record<string, unknown>;
  provider_permissions: Record<string, unknown>;
  connection_status: string;
  connection_checked_at: string | null;
  connection_message: string | null;
  created_at: string;
  updated_at: string;
}
interface AuditRow {
  readonly organization_id: string | null;
  readonly action: string;
  readonly scope: Record<string, unknown>;
  readonly subject: Record<string, unknown>;
}

interface FakeState {
  user: { id: string } | null;
  orgs: OrgRow[];
  secretManagers: SmRow[];
  resources: ResRow[];
  audit: AuditRow[];
  insertResourceError: { code?: string; message: string } | null;
  rlsDeniesAdminWrite: boolean;
}

const state: FakeState = {
  user: null,
  orgs: [],
  secretManagers: [],
  resources: [],
  audit: [],
  insertResourceError: null,
  rlsDeniesAdminWrite: false,
};

function resetState(): void {
  state.user = null;
  state.orgs = [];
  state.secretManagers = [];
  state.resources = [];
  state.audit = [];
  state.insertResourceError = null;
  state.rlsDeniesAdminWrite = false;
}

function applyEqs<T extends Record<string, unknown>>(
  rows: T[],
  eqs: ReadonlyArray<[string, unknown]>,
): T[] {
  return rows.filter((row) => eqs.every(([col, val]) => row[col] === val));
}

function pickTable(name: string): Array<Record<string, unknown>> {
  switch (name) {
    case 'organizations':
      return state.orgs as unknown as Array<Record<string, unknown>>;
    case 'secret_managers':
      return state.secretManagers as unknown as Array<Record<string, unknown>>;
    case 'resources':
      return state.resources as unknown as Array<Record<string, unknown>>;
    case 'audit_log':
      return state.audit as unknown as Array<Record<string, unknown>>;
    default:
      throw new Error(`Unexpected table ${name}`);
  }
}

function selectChain(table: string, eqs: Array<[string, unknown]> = []): unknown {
  const chain = {
    eq(col: string, val: unknown) {
      return selectChain(table, [...eqs, [col, val]]);
    },
    in(_col: string, _vals: ReadonlyArray<unknown>) {
      return Promise.resolve({ data: [], error: null });
    },
    order(_col: string, _opts: { ascending: boolean }) {
      return Promise.resolve({ data: applyEqs(pickTable(table), eqs), error: null });
    },
    maybeSingle() {
      const rows = applyEqs(pickTable(table), eqs);
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    single() {
      const rows = applyEqs(pickTable(table), eqs);
      if (rows.length === 0) {
        return Promise.resolve({ data: null, error: { message: 'no rows' } });
      }
      return Promise.resolve({ data: rows[0], error: null });
    },
  };
  return chain;
}

function makeFakeDb(): unknown {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: state.user }, error: null }),
    },
    from(table: string) {
      return {
        select: () => selectChain(table),
        insert(row: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>) {
          if (table === 'audit_log') {
            const rows: ReadonlyArray<Record<string, unknown>> = Array.isArray(row) ? row : [row];
            for (const r of rows) {
              state.audit.push({
                organization_id: (r.organization_id as string | null) ?? null,
                action: r.action as string,
                scope: (r.scope as Record<string, unknown> | undefined) ?? {},
                subject: (r.subject as Record<string, unknown> | undefined) ?? {},
              });
            }
            const thenable: Promise<{ data: null; error: null }> = Promise.resolve({
              data: null,
              error: null,
            });
            return Object.assign(thenable, { select: () => selectChain(table) });
          }
          if (table === 'resources') {
            if (state.insertResourceError) {
              const err = state.insertResourceError;
              return {
                select: () => ({
                  single: () => Promise.resolve({ data: null, error: err }),
                }),
              };
            }
            if (state.rlsDeniesAdminWrite) {
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: '42501', message: 'forbidden' },
                    }),
                }),
              };
            }
            const r = row as Record<string, unknown>;
            const id = (r.id as string | undefined) ?? `res-${state.resources.length + 1}`;
            const now = '2026-05-21T00:00:00Z';
            const inserted: ResRow = {
              id,
              organization_id: r.organization_id as string,
              project_id: (r.project_id as string | null) ?? null,
              admin_resource_id: (r.admin_resource_id as string | null) ?? null,
              provider_name: r.provider_name as string,
              kind: r.kind as string,
              scope: r.scope as 'org' | 'project',
              is_admin: (r.is_admin as boolean) ?? false,
              name: r.name as string,
              variant: (r.variant as string | null) ?? null,
              provider_ref: (r.provider_ref as string | null) ?? null,
              console_url: null,
              setup_docs_url: null,
              health_test_cmd: null,
              status: (r.status as string) ?? 'pending',
              secret_manager_id: r.secret_manager_id as string,
              provider_metadata: (r.provider_metadata as Record<string, unknown>) ?? {},
              provider_permissions: {},
              connection_status: 'unknown',
              connection_checked_at: null,
              connection_message: null,
              created_at: now,
              updated_at: now,
            };
            state.resources.push(inserted);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: inserted, error: null }),
              }),
            };
          }
          throw new Error(`insert unsupported on table ${table}`);
        },
        delete() {
          if (table !== 'resources') throw new Error(`delete unsupported on ${table}`);
          const eqs: Array<[string, unknown]> = [];
          const chain = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              if (eqs.length === 2) {
                if (state.rlsDeniesAdminWrite) {
                  return Promise.resolve({ data: null, error: null });
                }
                const matched = applyEqs(
                  state.resources as unknown as Record<string, unknown>[],
                  eqs,
                );
                state.resources = state.resources.filter(
                  (r) => !matched.includes(r as unknown as Record<string, unknown>),
                );
                return Promise.resolve({ data: null, error: null });
              }
              return chain;
            },
          };
          return chain;
        },
        update() {
          throw new Error('update unsupported on resources');
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeDb()),
}));

interface ProvisionHandler {
  POST(
    req: Request,
    ctx: { params: Promise<{ orgId: string; adminId: string }> },
  ): Promise<Response>;
}
interface DestroyHandler {
  DELETE(req: Request, ctx: { params: Promise<{ orgId: string; rId: string }> }): Promise<Response>;
}

async function importProvision(): Promise<ProvisionHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/resources/[adminId]/provision/route');
  return mod as ProvisionHandler;
}
async function importDestroy(): Promise<DestroyHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/destroy-cloud-resource/route');
  return mod as DestroyHandler;
}

function seedOrgWithAdmin(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
  state.secretManagers = [{ id: 'sm-1', organization_id: 'org-1', is_default: true }];
  state.resources = [
    {
      id: 'admin-1',
      organization_id: 'org-1',
      project_id: null,
      admin_resource_id: null,
      provider_name: 'github',
      kind: 'github-org-admin',
      scope: 'org',
      is_admin: true,
      name: 'gh-admin',
      variant: null,
      provider_ref: null,
      console_url: null,
      setup_docs_url: null,
      health_test_cmd: null,
      status: 'active',
      secret_manager_id: 'sm-1',
      provider_metadata: { org: 'acme' },
      provider_permissions: {},
      connection_status: 'unknown',
      connection_checked_at: null,
      connection_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];
}

const PROJECT_UUID = '00000000-0000-0000-0000-000000000001';

describe('POST /api/crm/v1/orgs/:orgId/resources/:adminId/provision', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: '{}',
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the org is invisible', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [];
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/ghost/resources/admin-1/provision', {
        method: 'POST',
        body: '{}',
      }),
      { params: Promise.resolve({ orgId: 'ghost', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the admin resource does not exist', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    state.secretManagers = [{ id: 'sm-1', organization_id: 'org-1', is_default: true }];
    state.resources = [];
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: JSON.stringify({
          childKind: 'github-repo',
          name: 'repo-a',
          project_id: PROJECT_UUID,
          provider_ref: 'acme/repo-a',
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the target resource is not is_admin', async () => {
    seedOrgWithAdmin();
    state.resources[0]!.is_admin = false;
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: JSON.stringify({
          childKind: 'github-repo',
          name: 'repo-a',
          project_id: PROJECT_UUID,
          provider_ref: 'acme/repo-a',
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when childKind is not in admin.manages', async () => {
    seedOrgWithAdmin();
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: JSON.stringify({
          childKind: 'vercel-project',
          name: 'x',
          project_id: PROJECT_UUID,
          provider_ref: 'prj_xxx',
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe('invalid_field');
    expect(body.message).toMatch(/admin\.manages/);
  });

  it('inserts a pending github-repo and audits resource.provisioned', async () => {
    seedOrgWithAdmin();
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: JSON.stringify({
          childKind: 'github-repo',
          name: 'repo-a',
          project_id: PROJECT_UUID,
          provider_ref: 'acme/repo-a',
          metadata: { org: 'acme', repo: 'repo-a' },
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      resource: ResRow;
      resource_id: string;
    };
    expect(body.resource.kind).toBe('github-repo');
    expect(body.resource.scope).toBe('project');
    expect(body.resource.admin_resource_id).toBe('admin-1');
    expect(body.resource.status).toBe('pending');
    expect(body.resource.provider_ref).toBe('acme/repo-a');
    expect(state.audit.find((a) => a.action === 'resource.provisioned')).toBeDefined();
  });

  it('ZK: audit_log subject does not leak any cleartext-looking cred', async () => {
    seedOrgWithAdmin();
    const mod = await importProvision();
    await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: JSON.stringify({
          childKind: 'github-repo',
          name: 'repo-zk',
          project_id: PROJECT_UUID,
          provider_ref: 'acme/repo-zk',
          metadata: { org: 'acme', repo: 'repo-zk' },
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    const audit = state.audit.find((a) => a.action === 'resource.provisioned');
    expect(audit).toBeDefined();
    const json = JSON.stringify(audit);
    expect(json).not.toMatch(/github_pat_/);
    expect(json).not.toMatch(/sbp_/);
    expect(json).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // JWT prefix
  });

  it('returns 400 when provider_ref is missing', async () => {
    seedOrgWithAdmin();
    const mod = await importProvision();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/admin-1/provision', {
        method: 'POST',
        body: JSON.stringify({ childKind: 'github-repo', name: 'r', project_id: PROJECT_UUID }),
      }),
      { params: Promise.resolve({ orgId: 'acme', adminId: 'admin-1' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.message).toMatch(/provider_ref/);
  });
});

describe('DELETE /api/crm/v1/orgs/:orgId/resources/:rId/destroy-cloud-resource', () => {
  beforeEach(() => {
    resetState();
  });

  function seedAdminAndProvisionedChild(): void {
    seedOrgWithAdmin();
    state.resources.push({
      id: 'child-1',
      organization_id: 'org-1',
      project_id: PROJECT_UUID,
      admin_resource_id: 'admin-1',
      provider_name: 'github',
      kind: 'github-repo',
      scope: 'project',
      is_admin: false,
      name: 'repo-a',
      variant: null,
      provider_ref: 'acme/repo-a',
      console_url: null,
      setup_docs_url: null,
      health_test_cmd: null,
      status: 'active',
      secret_manager_id: 'sm-1',
      provider_metadata: {},
      provider_permissions: {},
      connection_status: 'unknown',
      connection_checked_at: null,
      connection_message: null,
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  }

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importDestroy();
    const res = await mod.DELETE(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/child-1/destroy-cloud-resource',
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'child-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('refuses scope=org (409)', async () => {
    seedOrgWithAdmin();
    const mod = await importDestroy();
    const res = await mod.DELETE(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/admin-1/destroy-cloud-resource',
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'admin-1' }) },
    );
    expect(res.status).toBe(409);
  });

  it('refuses a project resource without admin_resource_id (409)', async () => {
    seedAdminAndProvisionedChild();
    state.resources[1]!.admin_resource_id = null;
    const mod = await importDestroy();
    const res = await mod.DELETE(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/child-1/destroy-cloud-resource',
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'child-1' }) },
    );
    expect(res.status).toBe(409);
  });

  it('deletes the resource row and audits resource.destroyed-cloud-side', async () => {
    seedAdminAndProvisionedChild();
    const mod = await importDestroy();
    const res = await mod.DELETE(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/child-1/destroy-cloud-resource',
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'child-1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.resources.find((r) => r.id === 'child-1')).toBeUndefined();
    expect(state.audit.find((a) => a.action === 'resource.destroyed-cloud-side')).toBeDefined();
  });
});
