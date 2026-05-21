/**
 * Phase 6 wave B — tests for the enriched rotation dispatcher
 * (`POST /access/:key/rotate`) and the recipients_stale=false reset
 * on `PUT /access/:key`.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.4, §7.4, §4.5.
 *
 * The fake Supabase client tracks the resource_access store and
 * exposes the row's `recipients_stale` field so we can assert the
 * Phase 5 TODO fix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { generateUserKeypair, sealForRecipients } from '@crm/core/crypto';

interface OrgRow {
  readonly id: string;
  readonly slug: string;
}
interface ResRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly scope: string;
  readonly admin_resource_id: string | null;
  readonly provider_ref: string | null;
  readonly is_admin: boolean;
}
interface AccessStoreRow {
  id: string;
  resource_id: string;
  key: string;
  sealed_blob: string;
  description: string | null;
  rotated_at: string;
  recipients_stale: boolean;
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
  resources: ResRow[];
  access: AccessStoreRow[];
  audit: AuditRow[];
}

const state: FakeState = {
  user: null,
  orgs: [],
  resources: [],
  access: [],
  audit: [],
};

function resetState(): void {
  state.user = null;
  state.orgs = [];
  state.resources = [];
  state.access = [];
  state.audit = [];
}

function applyEqs(
  rows: ReadonlyArray<Record<string, unknown>>,
  eqs: ReadonlyArray<[string, unknown]>,
): ReadonlyArray<Record<string, unknown>> {
  return rows.filter((row) => eqs.every(([col, val]) => row[col] === val));
}

function pickTable(name: string): Array<Record<string, unknown>> {
  switch (name) {
    case 'organizations':
      return state.orgs as unknown as Array<Record<string, unknown>>;
    case 'resources':
      return state.resources as unknown as Array<Record<string, unknown>>;
    case 'resource_access':
      return state.access as unknown as Array<Record<string, unknown>>;
    case 'audit_log':
      return state.audit as unknown as Array<Record<string, unknown>>;
    default:
      throw new Error(`Unexpected table ${name}`);
  }
}

function selectChain(table: string, eqs: Array<[string, unknown]> = []): unknown {
  return {
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
    then<T1, T2>(
      onfulfilled?: (v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
      onrejected?: (r: unknown) => T2 | PromiseLike<T2>,
    ) {
      return Promise.resolve({ data: applyEqs(pickTable(table), eqs), error: null }).then(
        onfulfilled,
        onrejected,
      );
    },
  };
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
          throw new Error(`insert unsupported on table ${table}`);
        },
        upsert(row: Record<string, unknown>, _opts?: { onConflict?: string }) {
          if (table !== 'resource_access') throw new Error(`upsert unsupported on ${table}`);
          const idx = state.access.findIndex(
            (a) => a.resource_id === row.resource_id && a.key === row.key,
          );
          const stored: AccessStoreRow = {
            id: idx >= 0 ? state.access[idx]!.id : `acc-${state.access.length + 1}`,
            resource_id: row.resource_id as string,
            key: row.key as string,
            sealed_blob: row.sealed_blob as string,
            description: (row.description as string | null) ?? null,
            rotated_at: (row.rotated_at as string) ?? '2026-05-21T00:00:00Z',
            recipients_stale: (row.recipients_stale as boolean | undefined) ?? false,
          };
          if (idx >= 0) state.access[idx] = stored;
          else state.access.push(stored);
          const thenable: Promise<{ data: AccessStoreRow; error: null }> = Promise.resolve({
            data: stored,
            error: null,
          });
          return Object.assign(thenable, {
            select: () => ({
              single: () => Promise.resolve({ data: stored, error: null }),
            }),
          });
        },
        delete() {
          throw new Error('delete unsupported');
        },
        update() {
          throw new Error('update unsupported');
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeDb()),
}));

interface RotateHandler {
  POST(
    req: Request,
    ctx: { params: Promise<{ orgId: string; rId: string; key: string }> },
  ): Promise<Response>;
}
interface AccessItemHandler {
  PUT(
    req: Request,
    ctx: { params: Promise<{ orgId: string; rId: string; key: string }> },
  ): Promise<Response>;
}

async function importRotate(): Promise<RotateHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/rotate/route');
  return mod as RotateHandler;
}
async function importAccessItem(): Promise<AccessItemHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/route');
  return mod as AccessItemHandler;
}

function seedManualKind(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
  state.resources = [
    {
      id: 'res-org',
      organization_id: 'org-1',
      kind: 'github-org',
      scope: 'org',
      admin_resource_id: null,
      provider_ref: null,
      is_admin: false,
    },
  ];
}

function seedAdminMediatedChild(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
  state.resources = [
    {
      id: 'admin-1',
      organization_id: 'org-1',
      kind: 'github-org-admin',
      scope: 'org',
      admin_resource_id: null,
      provider_ref: null,
      is_admin: true,
    },
    {
      id: 'child-1',
      organization_id: 'org-1',
      kind: 'github-repo',
      scope: 'project',
      admin_resource_id: 'admin-1',
      provider_ref: 'acme/repo-a',
      is_admin: false,
    },
  ];
}

describe('POST /access/:key/rotate dispatcher', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importRotate();
    const res = await mod.POST(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN/rotate',
        {
          method: 'POST',
        },
      ),
      {
        params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 202 + manual dispatch for a manual-rotation kind (github-org)', async () => {
    seedManualKind();
    const mod = await importRotate();
    const res = await mod.POST(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/res-org/access/GITHUB_TOKEN/rotate',
        {
          method: 'POST',
        },
      ),
      {
        params: Promise.resolve({ orgId: 'acme', rId: 'res-org', key: 'GITHUB_TOKEN' }),
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rotation_method).toBe('manual');
    expect(body.next_step).toBe('operator-action');
    expect(typeof body.setup_docs).toBe('string');
    expect(state.audit.find((a) => a.action === 'resource.access.rotate.requested')).toBeDefined();
  });

  it('returns 202 + admin-mediated dispatch with admin_resource_id and child_provider_ref', async () => {
    seedAdminMediatedChild();
    const mod = await importRotate();
    const res = await mod.POST(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/child-1/access/GITHUB_TOKEN/rotate',
        {
          method: 'POST',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'child-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rotation_method).toBe('admin-mediated');
    expect(body.next_step).toBe('admin-rotate-child');
    expect(body.admin_resource_id).toBe('admin-1');
    expect(body.admin_kind).toBe('github-org-admin');
    expect(body.child_provider_ref).toBe('acme/repo-a');
  });

  it('admin-mediated with missing admin returns message and null admin_resource_id', async () => {
    seedAdminMediatedChild();
    state.resources = state.resources.filter((r) => r.id !== 'admin-1');
    const mod = await importRotate();
    const res = await mod.POST(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/child-1/access/GITHUB_TOKEN/rotate',
        {
          method: 'POST',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'child-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.admin_resource_id).toBeNull();
    expect(body.message).toMatch(/Re-attach an admin|re-attach an admin/);
  });
});

describe('PUT /access/:key resets recipients_stale to false', () => {
  beforeEach(() => {
    resetState();
  });

  it('flips recipients_stale=false on upsert', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    state.resources = [
      {
        id: 'res-1',
        organization_id: 'org-1',
        kind: 'github-org',
        scope: 'org',
        admin_resource_id: null,
        provider_ref: null,
        is_admin: false,
      },
    ];
    state.access = [
      {
        id: 'acc-1',
        resource_id: 'res-1',
        key: 'GITHUB_TOKEN',
        sealed_blob: '',
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
        recipients_stale: true,
      },
    ];

    const alice = await generateUserKeypair();
    const bob = await generateUserKeypair();
    const blob = await sealForRecipients(new TextEncoder().encode('newvalue'), [
      { publicKey: alice.publicKey, fingerprint: alice.fingerprint },
      { publicKey: bob.publicKey, fingerprint: bob.fingerprint },
    ]);

    const mod = await importAccessItem();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify(blob),
      }),
      {
        params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }),
      },
    );
    expect(res.status).toBe(200);
    expect(state.access[0]?.recipients_stale).toBe(false);
  });
});
