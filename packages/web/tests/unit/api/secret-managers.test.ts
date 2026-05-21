/**
 * Unit tests for `/api/crm/v1/orgs/:orgId/secret-managers` route handlers.
 *
 * Mocks the Supabase client with an in-memory chained store, the same
 * pattern used in `resources.test.ts` (Phase 4). RLS denial surfaces as
 * `{ error: { code: '42501' } }`.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.2, §5.2.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface OrgRow {
  readonly id: string;
  readonly slug: string;
}
interface SmRow {
  id: string;
  organization_id: string;
  kind: string;
  name: string;
  is_default: boolean;
  config: Record<string, unknown>;
  auth_sealed_blob: string | null;
  created_at: string;
}
interface ResRow {
  id: string;
  organization_id: string;
  secret_manager_id: string;
  name?: string;
}
interface AccessRow {
  resource_id: string;
  key: string;
  recipients_stale: boolean;
}
interface AuditRow {
  organization_id: string | null;
  action: string;
  scope: Record<string, unknown>;
  subject: Record<string, unknown>;
}

interface FakeState {
  user: { id: string } | null;
  orgs: OrgRow[];
  sms: SmRow[];
  resources: ResRow[];
  resource_access: AccessRow[];
  audit: AuditRow[];
  insertSmError: { code?: string; message: string } | null;
  rlsDeniesAdminWrite: boolean;
}

const state: FakeState = {
  user: null,
  orgs: [],
  sms: [],
  resources: [],
  resource_access: [],
  audit: [],
  insertSmError: null,
  rlsDeniesAdminWrite: false,
};

function resetState(): void {
  state.user = null;
  state.orgs = [];
  state.sms = [];
  state.resources = [];
  state.resource_access = [];
  state.audit = [];
  state.insertSmError = null;
  state.rlsDeniesAdminWrite = false;
}

function applyEqs<T extends Record<string, unknown>>(
  rows: T[],
  eqs: Array<[string, unknown]>,
): T[] {
  return rows.filter((r) => eqs.every(([col, val]) => r[col] === val));
}

function pickTable(name: string): Array<Record<string, unknown>> {
  switch (name) {
    case 'organizations':
      return state.orgs as unknown as Array<Record<string, unknown>>;
    case 'secret_managers':
      return state.sms as unknown as Array<Record<string, unknown>>;
    case 'resources':
      return state.resources as unknown as Array<Record<string, unknown>>;
    case 'resource_access':
      return state.resource_access as unknown as Array<Record<string, unknown>>;
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
    in(col: string, vals: ReadonlyArray<unknown>) {
      const rows = pickTable(table).filter((r) => vals.includes(r[col]));
      return {
        eq(c: string, v: unknown) {
          const filtered = rows.filter((r) => r[c] === v);
          return {
            order: () => Promise.resolve({ data: filtered, error: null }),
          };
        },
        order: () => Promise.resolve({ data: rows, error: null }),
      };
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
      if (rows.length === 0) return Promise.resolve({ data: null, error: { message: 'no rows' } });
      return Promise.resolve({ data: rows[0], error: null });
    },
    then<T1, T2>(
      onfulfilled?: (v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
      onrejected?: (r: unknown) => T2 | PromiseLike<T2>,
    ) {
      const rows = applyEqs(pickTable(table), eqs);
      return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
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
                scope: (r.scope as Record<string, unknown>) ?? {},
                subject: (r.subject as Record<string, unknown>) ?? {},
              });
            }
            const thenable: Promise<{ data: null; error: null }> = Promise.resolve({
              data: null,
              error: null,
            });
            return Object.assign(thenable, { select: () => selectChain(table) });
          }
          if (table === 'secret_managers') {
            if (state.insertSmError) {
              const err = state.insertSmError;
              return {
                select: () => ({
                  single: () => Promise.resolve({ data: null, error: err }),
                  maybeSingle: () => Promise.resolve({ data: null, error: err }),
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
            // Enforce the partial unique index on is_default.
            if (
              r.is_default === true &&
              state.sms.some(
                (s) => s.organization_id === r.organization_id && s.is_default === true,
              )
            ) {
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: '23505', message: 'duplicate default' },
                    }),
                }),
              };
            }
            const inserted: SmRow = {
              id: (r.id as string | undefined) ?? `sm-${state.sms.length + 1}`,
              organization_id: r.organization_id as string,
              kind: r.kind as string,
              name: r.name as string,
              is_default: (r.is_default as boolean) ?? false,
              config: (r.config as Record<string, unknown>) ?? {},
              auth_sealed_blob: (r.auth_sealed_blob as string | null) ?? null,
              created_at: '2026-05-21T00:00:00Z',
            };
            state.sms.push(inserted);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: inserted, error: null }),
              }),
            };
          }
          throw new Error(`insert unsupported on table ${table}`);
        },
        update(patch: Record<string, unknown>) {
          if (table !== 'secret_managers') throw new Error(`update unsupported on ${table}`);
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
                  const rows = applyEqs(state.sms as unknown as Record<string, unknown>[], eqs);
                  for (const r of rows) {
                    Object.assign(r, patch);
                  }
                  return Promise.resolve({ data: rows[0] ?? null, error: null });
                },
                then<T1, T2>(
                  onfulfilled?: (v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
                  onrejected?: (r: unknown) => T2 | PromiseLike<T2>,
                ) {
                  if (state.rlsDeniesAdminWrite) {
                    return Promise.resolve({ data: null, error: null }).then(
                      onfulfilled,
                      onrejected,
                    );
                  }
                  const rows = applyEqs(state.sms as unknown as Record<string, unknown>[], eqs);
                  for (const r of rows) Object.assign(r, patch);
                  return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
                },
              };
            },
          };
          return chain;
        },
        delete() {
          if (table !== 'secret_managers') throw new Error(`delete unsupported on ${table}`);
          const eqs: Array<[string, unknown]> = [];
          const chain = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              if (eqs.length === 2) {
                if (state.rlsDeniesAdminWrite) {
                  return Promise.resolve({ data: null, error: null });
                }
                const matched = applyEqs(state.sms as unknown as Record<string, unknown>[], eqs);
                state.sms = state.sms.filter(
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
  GET(req: Request, ctx: { params: Promise<{ orgId: string; smId: string }> }): Promise<Response>;
  PATCH(req: Request, ctx: { params: Promise<{ orgId: string; smId: string }> }): Promise<Response>;
  DELETE(
    req: Request,
    ctx: { params: Promise<{ orgId: string; smId: string }> },
  ): Promise<Response>;
}
interface NeedsResealHandler {
  GET(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}

async function importCollection(): Promise<CollectionHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/secret-managers/route');
  return mod as CollectionHandler;
}
async function importItem(): Promise<ItemHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/secret-managers/[smId]/route');
  return mod as ItemHandler;
}
async function importNeedsReseal(): Promise<NeedsResealHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/needs-reseal/route');
  return mod as NeedsResealHandler;
}

function seedOrg(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
}

// A 48-byte sealed-box envelope encoded as base64. Used as a stand-in
// ciphertext to satisfy the SealedBlob validator's minimum size check.
const FAKE_CT = Buffer.alloc(48, 1).toString('base64');
const FP_A = '0123456789abcdef0123456789abcdef';
const FP_B = 'fedcba9876543210fedcba9876543210';

const BASE_BODY = {
  kind: 'infisical',
  name: 'default',
  config: { workspace_id: 'ws-1', endpoint: 'https://eu.infisical.com' },
  auth_sealed_blob: {
    v: 1,
    recipients: [
      { fp: FP_A, ct: FAKE_CT },
      { fp: FP_B, ct: FAKE_CT },
    ],
  },
};

describe('GET /api/crm/v1/orgs/:orgId/secret-managers', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importCollection();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers'),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when org is not visible to the user', async () => {
    state.user = { id: 'u' };
    const mod = await importCollection();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/ghost/secret-managers'),
      { params: Promise.resolve({ orgId: 'ghost' }) },
    );
    expect(res.status).toBe(404);
  });

  it('lists the SMs of the org', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'default',
        is_default: true,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importCollection();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers'),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret_managers: SmRow[] };
    expect(body.secret_managers).toHaveLength(1);
    expect(body.secret_managers[0]?.is_default).toBe(true);
  });
});

describe('POST /api/crm/v1/orgs/:orgId/secret-managers', () => {
  beforeEach(() => {
    resetState();
  });

  it('creates an infisical SM and audits secret_manager.created without leaking the blob', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({ ...BASE_BODY, is_default: true }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { secret_manager: SmRow };
    expect(body.secret_manager.kind).toBe('infisical');
    expect(body.secret_manager.is_default).toBe(true);
    expect(state.audit.map((r) => r.action)).toContain('secret_manager.created');
    const audit = state.audit.find((r) => r.action === 'secret_manager.created');
    // ZK invariant: no ct / fp leak in audit.subject (only counts).
    const subjectJson = JSON.stringify(audit?.subject ?? {});
    expect(subjectJson).not.toContain(FAKE_CT);
    expect(subjectJson).not.toContain(FP_A);
    expect(audit?.subject.recipient_count).toBe(2);
  });

  it('refuses kind=vault as not_implemented 400', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({ ...BASE_BODY, kind: 'vault' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_implemented');
  });

  it('refuses kind=1password as not_implemented 400', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({ ...BASE_BODY, kind: '1password' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_implemented');
  });

  it('refuses an invalid endpoint (not http(s))', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({
          ...BASE_BODY,
          config: { workspace_id: 'ws', endpoint: 'ftp://x' },
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an invalid auth_sealed_blob (v != 1)', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({
          ...BASE_BODY,
          auth_sealed_blob: { v: 2, recipients: [{ fp: FP_A, ct: FAKE_CT }] },
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an invalid name slug', async () => {
    seedOrg();
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({ ...BASE_BODY, name: 'INVALID' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('enforces single is_default per org (unsets the previous default)', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-old',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'old',
        is_default: true,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify({ ...BASE_BODY, name: 'new', is_default: true }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(201);
    const defaults = state.sms.filter((s) => s.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.name).toBe('new');
  });

  it('returns 403 when RLS denies insert', async () => {
    seedOrg();
    state.rlsDeniesAdminWrite = true;
    const mod = await importCollection();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers', {
        method: 'POST',
        body: JSON.stringify(BASE_BODY),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/crm/v1/orgs/:orgId/secret-managers/:smId', () => {
  beforeEach(() => {
    resetState();
  });

  it('renames the SM and audits secret_manager.updated', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'old',
        is_default: false,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.PATCH(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/sm-1', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'new' }),
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'sm-1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.sms[0]?.name).toBe('new');
    expect(state.audit.map((r) => r.action)).toContain('secret_manager.updated');
  });

  it('rotates auth_sealed_blob without logging its bytes', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'default',
        is_default: true,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.PATCH(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/sm-1', {
        method: 'PATCH',
        body: JSON.stringify({
          auth_sealed_blob: {
            v: 1,
            recipients: [{ fp: FP_A, ct: FAKE_CT }],
          },
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'sm-1' }) },
    );
    expect(res.status).toBe(200);
    const audit = state.audit.find((r) => r.action === 'secret_manager.updated');
    const subjectJson = JSON.stringify(audit?.subject ?? {});
    expect(subjectJson).not.toContain(FAKE_CT);
    expect(subjectJson).not.toContain(FP_A);
    expect(audit?.subject.recipient_count).toBe(1);
  });

  it('refuses changing kind via PATCH', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'd',
        is_default: false,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.PATCH(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/sm-1', {
        method: 'PATCH',
        body: JSON.stringify({ kind: 'vault' }),
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'sm-1' }) },
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/crm/v1/orgs/:orgId/secret-managers/:smId', () => {
  beforeEach(() => {
    resetState();
  });

  it('refuses to delete the default SM (409 is_default)', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'd',
        is_default: true,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/sm-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'sm-1' }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('is_default');
  });

  it('refuses to delete a referenced SM (409 referenced)', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'd',
        is_default: false,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    state.resources = [{ id: 'res-1', organization_id: 'org-1', secret_manager_id: 'sm-1' }];
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/sm-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'sm-1' }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      referenced_resource_ids: string[];
    };
    expect(body.error).toBe('referenced');
    expect(body.referenced_resource_ids).toEqual(['res-1']);
  });

  it('deletes a non-default, non-referenced SM + audits', async () => {
    seedOrg();
    state.sms = [
      {
        id: 'sm-1',
        organization_id: 'org-1',
        kind: 'infisical',
        name: 'd',
        is_default: false,
        config: {},
        auth_sealed_blob: null,
        created_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/sm-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'sm-1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.sms).toHaveLength(0);
    expect(state.audit.map((r) => r.action)).toContain('secret_manager.deleted');
  });

  it('returns 404 when the SM does not exist', async () => {
    seedOrg();
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/secret-managers/ghost', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', smId: 'ghost' }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/crm/v1/orgs/:orgId/needs-reseal', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    const mod = await importNeedsReseal();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/acme/needs-reseal'), {
      params: Promise.resolve({ orgId: 'acme' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns count=0 + items=[] when no row is stale', async () => {
    seedOrg();
    state.resources = [
      { id: 'res-1', organization_id: 'org-1', secret_manager_id: 'sm-1', name: 'r1' },
    ];
    const mod = await importNeedsReseal();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/acme/needs-reseal'), {
      params: Promise.resolve({ orgId: 'acme' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; items: unknown[] };
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('returns the stale rows with their resource_name (RLS-scoped via the resources list)', async () => {
    seedOrg();
    state.resources = [
      { id: 'res-1', organization_id: 'org-1', secret_manager_id: 'sm-1', name: 'r1' },
      { id: 'res-2', organization_id: 'org-1', secret_manager_id: 'sm-1', name: 'r2' },
    ];
    state.resource_access = [
      { resource_id: 'res-1', key: 'MAIN', recipients_stale: true },
      { resource_id: 'res-2', key: 'ADMIN', recipients_stale: false },
      { resource_id: 'res-1', key: 'ADMIN', recipients_stale: true },
    ];
    const mod = await importNeedsReseal();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/acme/needs-reseal'), {
      params: Promise.resolve({ orgId: 'acme' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      items: Array<{ resource_id: string; key: string; resource_name: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.items.every((i) => i.resource_id === 'res-1')).toBe(true);
    expect(body.items.map((i) => i.resource_name)).toEqual(['r1', 'r1']);
  });
});
