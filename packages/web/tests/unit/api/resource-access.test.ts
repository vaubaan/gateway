/**
 * Unit tests for the `/api/crm/v1/orgs/:orgId/resources/:rId/access`
 * route handlers (list / get / put / delete / rotate).
 *
 * The Supabase client is faked with an in-memory store. The sealed_blob
 * column stores the canonical JSON serialised as bytea `\x<hex>`; the
 * helpers `sealedBlobToBytea` / `byteaToSealedBlob` are tested
 * end-to-end via the route's PUT → GET round-trip.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §4.3, §6.4.
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
}
interface AccessStoreRow {
  id: string;
  resource_id: string;
  key: string;
  sealed_blob: string;
  description: string | null;
  rotated_at: string;
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
  rlsDeniesAdminWrite: boolean;
}

const state: FakeState = {
  user: null,
  orgs: [],
  resources: [],
  access: [],
  audit: [],
  rlsDeniesAdminWrite: false,
};

function resetState(): void {
  state.user = null;
  state.orgs = [];
  state.resources = [];
  state.access = [];
  state.audit = [];
  state.rlsDeniesAdminWrite = false;
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
  const chain = {
    eq(col: string, val: unknown) {
      return selectChain(table, [...eqs, [col, val]]);
    },
    in(_col: string, _vals: ReadonlyArray<unknown>) {
      return Promise.resolve({ data: [], error: null });
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
          if (state.rlsDeniesAdminWrite) {
            const err = { code: '42501', message: 'forbidden' };
            const thenable: Promise<{ data: null; error: { code: string; message: string } }> =
              Promise.resolve({ data: null, error: err });
            return Object.assign(thenable, {
              select: () => ({
                single: () => Promise.resolve({ data: null, error: err }),
              }),
            });
          }
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
          if (table !== 'resource_access') throw new Error(`delete unsupported on ${table}`);
          const eqs: Array<[string, unknown]> = [];
          const chain = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              if (eqs.length === 2) {
                if (state.rlsDeniesAdminWrite) {
                  return Promise.resolve({ data: null, error: null });
                }
                const matched = applyEqs(state.access as unknown as Record<string, unknown>[], eqs);
                state.access = state.access.filter(
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
          throw new Error(`update unsupported on ${table}`);
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeDb()),
}));

interface ListHandler {
  GET(req: Request, ctx: { params: Promise<{ orgId: string; rId: string }> }): Promise<Response>;
}
interface ItemHandler {
  GET(
    req: Request,
    ctx: { params: Promise<{ orgId: string; rId: string; key: string }> },
  ): Promise<Response>;
  PUT(
    req: Request,
    ctx: { params: Promise<{ orgId: string; rId: string; key: string }> },
  ): Promise<Response>;
  DELETE(
    req: Request,
    ctx: { params: Promise<{ orgId: string; rId: string; key: string }> },
  ): Promise<Response>;
}
interface RotateHandler {
  POST(
    req: Request,
    ctx: { params: Promise<{ orgId: string; rId: string; key: string }> },
  ): Promise<Response>;
}

async function importList(): Promise<ListHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/route');
  return mod as ListHandler;
}
async function importItem(): Promise<ItemHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/route');
  return mod as ItemHandler;
}
async function importRotate(): Promise<RotateHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/rotate/route');
  return mod as RotateHandler;
}

function seedOrgAndResource(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
  state.resources = [{ id: 'res-1', organization_id: 'org-1', kind: 'github-org', scope: 'org' }];
}

async function makeBlob() {
  const alice = await generateUserKeypair();
  const bob = await generateUserKeypair();
  const blob = await sealForRecipients(new TextEncoder().encode('github_pat_supersecret'), [
    { publicKey: alice.publicKey, fingerprint: alice.fingerprint },
    { publicKey: bob.publicKey, fingerprint: bob.fingerprint },
  ]);
  return { blob, alice, bob };
}

describe('GET /access list', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importList();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access'),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns access summary without the sealed_blob bytes', async () => {
    seedOrgAndResource();
    const { blob } = await makeBlob();
    const bytea = `\\x${Buffer.from(JSON.stringify(blob), 'utf8').toString('hex')}`;
    state.access = [
      {
        id: 'acc-1',
        resource_id: 'res-1',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: 'fine-grained PAT',
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importList();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access'),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access: ReadonlyArray<{ key: string; recipient_count: number; description: string | null }>;
    };
    expect(body.access).toHaveLength(1);
    expect(body.access[0]?.key).toBe('GITHUB_TOKEN');
    expect(body.access[0]?.recipient_count).toBe(2);
    expect(body.access[0]?.description).toBe('fine-grained PAT');
    // The raw response body must NOT contain any `ct` field.
    const rawText = JSON.stringify(body);
    expect(rawText).not.toContain('"ct"');
  });
});

describe('GET /access/:key', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 404 when the row does not exist', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/MISSING_TOKEN'),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'MISSING_TOKEN' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns the canonical sealed_blob shape (v=1, recipients[])', async () => {
    seedOrgAndResource();
    const { blob } = await makeBlob();
    const bytea = `\\x${Buffer.from(JSON.stringify(blob), 'utf8').toString('hex')}`;
    state.access = [
      {
        id: 'acc-1',
        resource_id: 'res-1',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN'),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sealed_blob: { v: number; recipients: Array<{ fp: string; ct: string }> };
    };
    expect(body.sealed_blob.v).toBe(1);
    expect(body.sealed_blob.recipients).toHaveLength(2);
    expect(body.sealed_blob.recipients[0]?.fp).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('PUT /access/:key', () => {
  beforeEach(() => {
    resetState();
  });

  it('upserts a valid sealed_blob and audits with recipient_count only', async () => {
    seedOrgAndResource();
    const { blob } = await makeBlob();
    const mod = await importItem();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: blob, description: 'PAT acme/admin' }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(200);
    expect(state.access).toHaveLength(1);
    expect(state.audit.map((r) => r.action)).toContain('resource.access.put');
    const auditRow = state.audit[0]!;
    expect(auditRow.subject).toEqual({ recipient_count: 2 });
    // ZK invariant: no `ct` should ever land in audit_log.
    expect(JSON.stringify(auditRow)).not.toContain('"ct"');
  });

  it('refuses v != 1', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: { v: 2, recipients: [] } }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_field');
  });

  it('refuses an empty recipients array', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: { v: 1, recipients: [] } }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an fp that is not 32 hex chars', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({
          sealed_blob: {
            v: 1,
            recipients: [{ fp: 'NOTHEX', ct: 'AAAA' }],
          },
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses a ct that does not decode to ≥ 48 bytes', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const fp = 'a'.repeat(32);
    const tooShort = Buffer.from(new Uint8Array(10)).toString('base64');
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: { v: 1, recipients: [{ fp, ct: tooShort }] } }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses a ct that is not base64', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const fp = 'a'.repeat(32);
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: { v: 1, recipients: [{ fp, ct: 'not!base64!' }] } }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an invalid access key segment', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const { blob } = await makeBlob();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/lowercase', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: blob }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'lowercase' }) },
    );
    expect(res.status).toBe(400);
  });

  it('PUT then GET round-trip preserves the exact recipients[] shape', async () => {
    seedOrgAndResource();
    const { blob } = await makeBlob();
    const mod = await importItem();
    const putRes = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: blob }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(putRes.status).toBe(200);
    const getRes = await mod.GET(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN'),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    const body = (await getRes.json()) as {
      sealed_blob: { v: number; recipients: Array<{ fp: string; ct: string }> };
    };
    expect(body.sealed_blob).toEqual(blob);
  });

  it('returns 403 when RLS denies the upsert', async () => {
    seedOrgAndResource();
    state.rlsDeniesAdminWrite = true;
    const { blob } = await makeBlob();
    const mod = await importItem();
    const res = await mod.PUT(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'PUT',
        body: JSON.stringify({ sealed_blob: blob }),
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /access/:key', () => {
  beforeEach(() => {
    resetState();
  });

  it('deletes the row and audits resource.access.deleted', async () => {
    seedOrgAndResource();
    const { blob } = await makeBlob();
    state.access = [
      {
        id: 'acc-1',
        resource_id: 'res-1',
        key: 'GITHUB_TOKEN',
        sealed_blob: `\\x${Buffer.from(JSON.stringify(blob), 'utf8').toString('hex')}`,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(200);
    expect(state.access).toHaveLength(0);
    expect(state.audit.map((r) => r.action)).toContain('resource.access.deleted');
  });

  it('returns 404 when the key does not exist', async () => {
    seedOrgAndResource();
    const mod = await importItem();
    const res = await mod.DELETE(
      new Request('http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GHOST_KEY', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GHOST_KEY' }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /access/:key/rotate (dispatcher, Phase 6)', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 202 with rotation_method=manual for github-org', async () => {
    seedOrgAndResource();
    const mod = await importRotate();
    const res = await mod.POST(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN/rotate',
        {
          method: 'POST',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      rotation_method: string;
      next_step: string;
    };
    // Phase 6 wave B switched the payload from 'pending-runner' to
    // 'pending-dispatch' (the runner only handles the 'self' branch;
    // the browser dispatches the manual + admin-mediated branches).
    expect(body.status).toBe('pending-dispatch');
    expect(body.rotation_method).toBe('manual');
    expect(body.next_step).toBe('operator-action');
    expect(state.audit.map((r) => r.action)).toContain('resource.access.rotate.requested');
  });

  it('returns admin-rotate-child for github-repo (admin-mediated)', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    state.resources = [
      { id: 'res-1', organization_id: 'org-1', kind: 'github-repo', scope: 'project' },
    ];
    const mod = await importRotate();
    const res = await mod.POST(
      new Request(
        'http://localhost/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN/rotate',
        {
          method: 'POST',
        },
      ),
      { params: Promise.resolve({ orgId: 'acme', rId: 'res-1', key: 'GITHUB_TOKEN' }) },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { rotation_method: string; next_step: string };
    expect(body.rotation_method).toBe('admin-mediated');
    expect(body.next_step).toBe('admin-rotate-child');
  });
});
