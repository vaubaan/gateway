/**
 * Unit tests for the `/api/crm/v1/orgs/:orgId/resources` route handlers.
 *
 * The Supabase client is faked: the chained calls (select/eq/in/order/
 * maybeSingle/single, insert().select().single(), update().eq().eq().
 * select().maybeSingle(), delete().eq().eq()) are routed to an
 * in-memory store keyed by table. RLS-style denial is simulated by
 * surfacing an error with `code: '42501'` for the cases noted below.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.3, §7.1.
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

interface FilterStack {
  table: string;
  eqs: Array<[string, unknown]>;
}

function applyEqs<T extends Record<string, unknown>>(rows: T[], eqs: FilterStack['eqs']): T[] {
  return rows.filter((row) => eqs.every(([col, val]) => row[col] === val));
}

function selectChain(table: string, eqs: Array<[string, unknown]> = []): unknown {
  const chain = {
    eq(col: string, val: unknown) {
      return selectChain(table, [...eqs, [col, val]]);
    },
    in(col: string, vals: ReadonlyArray<unknown>) {
      const rows = pickTable(table).filter((r) => vals.includes(r[col]));
      return Promise.resolve({ data: rows, error: null });
    },
    order(_col: string, _opts: { ascending: boolean }) {
      const rows = applyEqs(pickTable(table), eqs);
      return Promise.resolve({ data: rows, error: null });
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
    then<T1, T2>(
      onfulfilled?: (v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
      onrejected?: (r: unknown) => T2 | PromiseLike<T2>,
    ) {
      const rows = applyEqs(pickTable(table), eqs);
      const result = { data: rows, error: null };
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  return chain;
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
                  maybeSingle: () => Promise.resolve({ data: null, error: err }),
                  eq: () => ({ single: () => Promise.resolve({ data: null, error: err }) }),
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
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
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
              console_url: (r.console_url as string | null) ?? null,
              setup_docs_url: (r.setup_docs_url as string | null) ?? null,
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
                maybeSingle: () => Promise.resolve({ data: inserted, error: null }),
              }),
            };
          }
          throw new Error(`insert unsupported on table ${table}`);
        },
        update(patch: Record<string, unknown>) {
          if (table !== 'resources') throw new Error(`update unsupported on ${table}`);
          const eqs: Array<[string, unknown]> = [];
          const chain = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              return chain;
            },
            select() {
              return {
                maybeSingle() {
                  if (state.rlsDeniesAdminWrite) {
                    return Promise.resolve({ data: null, error: null });
                  }
                  const rows = applyEqs(
                    state.resources as unknown as Record<string, unknown>[],
                    eqs,
                  );
                  for (const r of rows) {
                    Object.assign(r, patch);
                    (r as unknown as ResRow).updated_at = '2026-05-21T01:00:00Z';
                  }
                  return Promise.resolve({ data: rows[0] ?? null, error: null });
                },
              };
            },
          };
          return chain;
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
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeDb()),
}));

interface CollectionHandler {
  GET(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
  POST(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}
interface ItemHandler {
  GET(req: Request, ctx: { params: Promise<{ orgId: string; rId: string }> }): Promise<Response>;
  PATCH(req: Request, ctx: { params: Promise<{ orgId: string; rId: string }> }): Promise<Response>;
  DELETE(req: Request, ctx: { params: Promise<{ orgId: string; rId: string }> }): Promise<Response>;
}
interface HealthHandler {
  POST(req: Request, ctx: { params: Promise<{ orgId: string; rId: string }> }): Promise<Response>;
}

async function importCollection(): Promise<CollectionHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/resources/route');
  return mod as CollectionHandler;
}
async function importItem(): Promise<ItemHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/route');
  return mod as ItemHandler;
}
async function importHealth(): Promise<HealthHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/health/route');
  return mod as HealthHandler;
}
async function importRefresh(): Promise<HealthHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/refresh/route');
  return mod as HealthHandler;
}

function seedOrg(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
  state.secretManagers = [{ id: 'sm-1', organization_id: 'org-1', is_default: true }];
}

describe('GET /api/crm/v1/orgs/:orgId/resources', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importCollection();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/acme/resources'), {
      params: Promise.resolve({ orgId: 'acme' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when org is not visible to the user', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [];
    const mod = await importCollection();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/ghost/resources'), {
      params: Promise.resolve({ orgId: 'ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('lists resources with filters (scope, kind)', async () => {
    seedOrg();
    state.resources = [
      makeResource({ id: 'r1', kind: 'github-org', scope: 'org', is_admin: false, name: 'gh' }),
      makeResource({
        id: 'r2',
        kind: 'github-repo',
        scope: 'project',
        is_admin: false,
        name: 'repo-a',
        project_id: 'proj-1',
      }),
    ];
    const mod = await importCollection();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources?scope=org'),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: ResRow[] };
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]?.id).toBe('r1');
  });
});

describe('POST /api/crm/v1/orgs/:orgId/resources', () => {
  beforeEach(() => {
    resetState();
  });

  it('registers a github-org and audits resource.registered', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'github-org', name: 'gh-acme', metadata: { org: 'acme' } }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resource: ResRow };
    expect(body.resource.kind).toBe('github-org');
    expect(body.resource.scope).toBe('org');
    expect(body.resource.is_admin).toBe(false);
    expect(body.resource.status).toBe('pending');
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]?.action).toBe('resource.registered');
  });

  it('refuses an unknown kind', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'made-up-kind', name: 'x' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_kind');
  });

  it('refuses a project kind without project_id (scope/project mismatch)', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'github-repo', name: 'my-repo' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.error).toBe('invalid_field');
  });

  it('refuses an org kind with a project_id', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'github-org',
          name: 'gh',
          project_id: '00000000-0000-0000-0000-000000000001',
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an invalid slug (uppercase)', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'github-org', name: 'GH-ACME' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when org has no default secret_manager', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    state.secretManagers = [];
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'github-org', name: 'gh' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_default_secret_manager');
  });

  it('returns 403 when RLS denies insert (non-admin member)', async () => {
    seedOrg();
    state.rlsDeniesAdminWrite = true;
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'github-org', name: 'gh' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(403);
  });

  it('sets is_admin=true for an org-admin kind', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources', {
        method: 'POST',
        body: JSON.stringify({ kind: 'github-org-admin', name: 'gh-admin' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resource: ResRow };
    expect(body.resource.is_admin).toBe(true);
    expect(body.resource.scope).toBe('org');
  });
});

describe('PATCH /api/crm/v1/orgs/:orgId/resources/:rId', () => {
  beforeEach(() => {
    resetState();
  });

  it('updates mutable fields and audits resource.updated', async () => {
    seedOrg();
    state.resources = [makeResource({ id: 'r1', name: 'gh', kind: 'github-org', scope: 'org' })];
    const mod = await importItem();
    const res = await mod.PATCH(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/r1', {
        method: 'PATCH',
        body: JSON.stringify({ console_url: 'https://github.com/acme', status: 'active' }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'r1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.audit.map((r) => r.action)).toContain('resource.updated');
    expect(state.resources[0]?.status).toBe('active');
  });

  it('rejects forbidden field changes (kind, scope)', async () => {
    seedOrg();
    state.resources = [makeResource({ id: 'r1', name: 'gh', kind: 'github-org', scope: 'org' })];
    const mod = await importItem();
    const res = await mod.PATCH(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/r1', {
        method: 'PATCH',
        body: JSON.stringify({ kind: 'github-repo' }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'r1' }) },
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/crm/v1/orgs/:orgId/resources/:rId', () => {
  beforeEach(() => {
    resetState();
  });

  it('detaches a resource (no destroy-cloud-resource) and audits', async () => {
    seedOrg();
    state.resources = [makeResource({ id: 'r1', name: 'gh', kind: 'github-org', scope: 'org' })];
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/r1', { method: 'DELETE' }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'r1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.resources).toHaveLength(0);
    expect(state.audit.map((r) => r.action)).toContain('resource.deleted');
  });

  it('returns 404 when the resource does not exist', async () => {
    seedOrg();
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/missing', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'missing' }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /health and /refresh stubs', () => {
  beforeEach(() => {
    resetState();
  });

  it('health accepts a browser probe result and audits it', async () => {
    seedOrg();
    state.resources = [makeResource({ id: 'r1', name: 'gh', kind: 'github-org', scope: 'org' })];
    const mod = await importHealth();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/r1/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'connected', message: 'GET /orgs/acme 200' }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'r1' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message: string };
    expect(body.status).toBe('connected');
    expect(state.audit.map((r) => r.action)).toContain('resource.health.checked');
  });

  it('refresh returns 202 pending-runner + audits', async () => {
    seedOrg();
    state.resources = [makeResource({ id: 'r1', name: 'gh', kind: 'github-org', scope: 'org' })];
    const mod = await importRefresh();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/r1/refresh', { method: 'POST' }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'r1' }) },
    );
    expect(res.status).toBe(202);
    expect(state.audit.map((r) => r.action)).toContain('resource.refresh.requested');
  });
});

function makeResource(over: Partial<ResRow>): ResRow {
  return {
    id: 'r0',
    organization_id: 'org-1',
    project_id: null,
    admin_resource_id: null,
    provider_name: 'github',
    kind: 'github-org',
    scope: 'org',
    is_admin: false,
    name: 'r',
    variant: null,
    provider_ref: null,
    console_url: null,
    setup_docs_url: null,
    health_test_cmd: null,
    status: 'pending',
    secret_manager_id: 'sm-1',
    provider_metadata: {},
    provider_permissions: {},
    connection_status: 'unknown',
    connection_checked_at: null,
    connection_message: null,
    created_at: '2026-05-21T00:00:00Z',
    updated_at: '2026-05-21T00:00:00Z',
    ...over,
  };
}
