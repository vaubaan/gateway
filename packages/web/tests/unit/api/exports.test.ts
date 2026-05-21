/**
 * Unit tests for the Phase 7 wave A2 exports REST endpoints:
 *
 *   - POST /api/crm/v1/orgs/:orgId/exports/env
 *   - POST /api/crm/v1/orgs/:orgId/exports/mcp
 *   - POST /api/crm/v1/orgs/:orgId/exports/cloud-resource-map
 *
 * The Supabase client is faked with an in-memory store. We assert:
 *
 *   - Routes only return sealed_blobs (no cleartext / "ct" field
 *     extraction is opaque — the test asserts the response carries the
 *     canonical SealedBlobV1 shape).
 *   - cloud-resource-map carries NO sealed_blob fields anywhere.
 *   - Audit subject carries counts only.
 *   - Variant filtering : project-scope with variant='staging' includes
 *     org-scope + project-scope variant='staging' + project-scope
 *     variant IS NULL.
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
  readonly project_id: string | null;
  readonly kind: string;
  readonly scope: 'org' | 'project';
  readonly name: string;
  readonly variant: string | null;
  readonly provider_metadata: Record<string, unknown>;
  readonly secret_manager_id: string;
}
interface AccessStoreRow {
  readonly id: string;
  readonly resource_id: string;
  readonly key: string;
  readonly sealed_blob: string;
  readonly description: string | null;
  readonly rotated_at: string;
}
interface SmRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly name: string;
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
  secretManagers: SmRow[];
  audit: AuditRow[];
}

const state: FakeState = {
  user: null,
  orgs: [],
  resources: [],
  access: [],
  secretManagers: [],
  audit: [],
};

function resetState(): void {
  state.user = null;
  state.orgs = [];
  state.resources = [];
  state.access = [];
  state.secretManagers = [];
  state.audit = [];
}

interface Filter {
  kind: 'eq' | 'is' | 'or' | 'in';
  col?: string;
  val?: unknown;
  vals?: ReadonlyArray<unknown>;
  filter?: string;
}

function applyFilters<T extends Record<string, unknown>>(rows: T[], filters: Filter[]): T[] {
  let out = rows.slice();
  for (const f of filters) {
    if (f.kind === 'eq') out = out.filter((r) => r[f.col!] === f.val);
    else if (f.kind === 'is') out = out.filter((r) => r[f.col!] === null);
    else if (f.kind === 'in') out = out.filter((r) => f.vals!.includes(r[f.col!]));
    else if (f.kind === 'or') {
      const parts = (f.filter ?? '').split(',');
      out = out.filter((r) =>
        parts.some((p) => {
          const m = p.match(/^([a-z_]+)\.(eq|is)\.(.+)$/);
          if (!m) return false;
          const col = m[1]!;
          const op = m[2]!;
          const val = m[3]!;
          if (op === 'is' && val === 'null') return r[col] === null;
          if (op === 'eq') return r[col] === val;
          return false;
        }),
      );
    }
  }
  return out;
}

function pickTable(name: string): Array<Record<string, unknown>> {
  switch (name) {
    case 'organizations':
      return state.orgs as unknown as Array<Record<string, unknown>>;
    case 'resources':
      return state.resources as unknown as Array<Record<string, unknown>>;
    case 'resource_access':
      return state.access as unknown as Array<Record<string, unknown>>;
    case 'secret_managers':
      return state.secretManagers as unknown as Array<Record<string, unknown>>;
    case 'audit_log':
      return state.audit as unknown as Array<Record<string, unknown>>;
    default:
      throw new Error(`Unexpected table ${name}`);
  }
}

interface Chain {
  eq(col: string, val: unknown): Chain;
  is(col: string, val: unknown): Chain;
  or(filter: string): Chain;
  in(col: string, vals: ReadonlyArray<unknown>): Chain;
  order(col: string, opts: { ascending: boolean }): Chain;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  single(): Promise<{ data: unknown; error: { message: string } | null }>;
  then<T1, T2>(
    onfulfilled?: (v: { data: unknown; error: null }) => T1 | PromiseLike<T1>,
    onrejected?: (r: unknown) => T2 | PromiseLike<T2>,
  ): Promise<T1 | T2>;
}

function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  col: string,
  ascending: boolean,
): T[] {
  return rows.slice().sort((a, b) => {
    const va = a[col];
    const vb = b[col];
    if (va === undefined || vb === undefined) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'string' && typeof vb === 'string') {
      if (va === vb) return 0;
      return ascending ? (va < vb ? -1 : 1) : va < vb ? 1 : -1;
    }
    return 0;
  });
}

function selectChain(
  table: string,
  filters: Filter[] = [],
  orderCol: string | null = null,
  orderAsc = true,
): Chain {
  return {
    eq(col, val) {
      return selectChain(table, [...filters, { kind: 'eq', col, val }], orderCol, orderAsc);
    },
    is(col, _val) {
      return selectChain(table, [...filters, { kind: 'is', col }], orderCol, orderAsc);
    },
    or(filter) {
      return selectChain(table, [...filters, { kind: 'or', filter }], orderCol, orderAsc);
    },
    in(col, vals) {
      return selectChain(table, [...filters, { kind: 'in', col, vals }], orderCol, orderAsc);
    },
    order(col, opts) {
      return selectChain(table, filters, col, opts.ascending);
    },
    maybeSingle() {
      const rows = applyFilters(pickTable(table), filters);
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    single() {
      const rows = applyFilters(pickTable(table), filters);
      if (rows.length === 0) {
        return Promise.resolve({ data: null, error: { message: 'no rows' } });
      }
      return Promise.resolve({ data: rows[0], error: null });
    },
    then(onfulfilled, onrejected) {
      let rows = applyFilters(pickTable(table), filters);
      if (orderCol !== null) rows = sortRows(rows, orderCol, orderAsc);
      return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
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
            return Promise.resolve({ data: null, error: null });
          }
          throw new Error(`insert unsupported on table ${table}`);
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeDb()),
}));

interface EnvHandler {
  POST(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}
interface McpHandler {
  POST(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}
interface MapHandler {
  POST(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}

async function importEnv(): Promise<EnvHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/exports/env/route');
  return mod as EnvHandler;
}
async function importMcp(): Promise<McpHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/exports/mcp/route');
  return mod as McpHandler;
}
async function importMap(): Promise<MapHandler> {
  const mod: unknown =
    await import('@/app/api/crm/v1/orgs/[orgId]/exports/cloud-resource-map/route');
  return mod as MapHandler;
}

async function blobBytea(text: string): Promise<{ bytea: string; recipientFps: string[] }> {
  const alice = await generateUserKeypair();
  const bob = await generateUserKeypair();
  const blob = await sealForRecipients(new TextEncoder().encode(text), [
    { publicKey: alice.publicKey, fingerprint: alice.fingerprint },
    { publicKey: bob.publicKey, fingerprint: bob.fingerprint },
  ]);
  const bytea = `\\x${Buffer.from(JSON.stringify(blob), 'utf8').toString('hex')}`;
  return { bytea, recipientFps: [alice.fingerprint, bob.fingerprint] };
}

function seedBasicOrg(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
  state.secretManagers = [
    { id: 'sm-1', organization_id: 'org-1', kind: 'infisical', name: 'default' },
  ];
}

describe('POST /exports/env', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importEnv();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/env', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 on missing scope', async () => {
    seedBasicOrg();
    const mod = await importEnv();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/env', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns the sealed_blobs of every Access visible at scope=org', async () => {
    seedBasicOrg();
    state.resources = [
      {
        id: 'r-gh',
        organization_id: 'org-1',
        project_id: null,
        kind: 'github-org',
        scope: 'org',
        name: 'acme-gh',
        variant: null,
        provider_metadata: { org: 'acme' },
        secret_manager_id: 'sm-1',
      },
    ];
    const { bytea } = await blobBytea('github_pat_supersecret');
    state.access = [
      {
        id: 'a-1',
        resource_id: 'r-gh',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importEnv();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/env', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org', format: 'dotenv' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      entries: ReadonlyArray<{
        key: string;
        source_resource_id: string;
        sealed_blob: { v: number; recipients: ReadonlyArray<{ fp: string; ct: string }> };
      }>;
    };
    expect(body.format).toBe('dotenv');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.key).toBe('GITHUB_TOKEN');
    expect(body.entries[0]!.sealed_blob.v).toBe(1);
    expect(body.entries[0]!.sealed_blob.recipients).toHaveLength(2);
    // ZK invariant: the response shape carries `ct` (the sealed
    // ciphertext) only inside `sealed_blob.recipients`. It must NOT
    // appear as a top-level cleartext field.
    const json = JSON.stringify(body);
    expect(json).not.toContain('github_pat_supersecret');

    // Audit: action + counts only, no `ct`.
    const auditRow = state.audit.find((r) => r.action === 'resource.access.exported');
    expect(auditRow).toBeDefined();
    expect(auditRow!.subject).toMatchObject({ resource_count: 1, entry_count: 1 });
    expect(JSON.stringify(auditRow)).not.toContain('github_pat');
  });

  it('project-scope unions project+org Accesses with variant filter', async () => {
    seedBasicOrg();
    const projUuid = '00000000-0000-0000-0000-000000000001';
    state.resources = [
      {
        id: 'r-gh',
        organization_id: 'org-1',
        project_id: null,
        kind: 'github-org',
        scope: 'org',
        name: 'acme-gh',
        variant: null,
        provider_metadata: { org: 'acme' },
        secret_manager_id: 'sm-1',
      },
      {
        id: 'r-repo-staging',
        organization_id: 'org-1',
        project_id: projUuid,
        kind: 'github-repo',
        scope: 'project',
        name: 'frontend',
        variant: 'staging',
        provider_metadata: { org: 'acme', repo: 'frontend' },
        secret_manager_id: 'sm-1',
      },
      {
        id: 'r-repo-prod',
        organization_id: 'org-1',
        project_id: projUuid,
        kind: 'github-repo',
        scope: 'project',
        name: 'frontend',
        variant: 'prod',
        provider_metadata: { org: 'acme', repo: 'frontend' },
        secret_manager_id: 'sm-1',
      },
      {
        id: 'r-repo-novariant',
        organization_id: 'org-1',
        project_id: projUuid,
        kind: 'github-repo',
        scope: 'project',
        name: 'shared',
        variant: null,
        provider_metadata: { org: 'acme', repo: 'shared' },
        secret_manager_id: 'sm-1',
      },
    ];
    const { bytea } = await blobBytea('shared');
    state.access = [
      {
        id: 'a-1',
        resource_id: 'r-gh',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
      {
        id: 'a-2',
        resource_id: 'r-repo-staging',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
      {
        id: 'a-3',
        resource_id: 'r-repo-prod',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
      {
        id: 'a-4',
        resource_id: 'r-repo-novariant',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importEnv();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/env', {
        method: 'POST',
        body: JSON.stringify({ scope: 'project', scopeId: projUuid, variant: 'staging' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: ReadonlyArray<{ source_resource_id: string }>;
    };
    // Expected union: r-gh (org-scope) + r-repo-staging (variant match) +
    //                r-repo-novariant (variant IS NULL). r-repo-prod is
    //                filtered out.
    const ids = body.entries.map((e) => e.source_resource_id).sort();
    expect(ids).toEqual(['r-gh', 'r-repo-novariant', 'r-repo-staging']);
  });
});

describe('POST /exports/mcp', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns mcp_json + env_template + sealed env_entries', async () => {
    seedBasicOrg();
    state.resources = [
      {
        id: 'r-gh',
        organization_id: 'org-1',
        project_id: null,
        kind: 'github-org',
        scope: 'org',
        name: 'acme-gh',
        variant: null,
        provider_metadata: { org: 'acme' },
        secret_manager_id: 'sm-1',
      },
    ];
    const { bytea } = await blobBytea('github_pat_supersecret');
    state.access = [
      {
        id: 'a-1',
        resource_id: 'r-gh',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importMcp();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/mcp', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mcp_json: { mcpServers: Record<string, unknown> };
      env_manifest: { keys: ReadonlyArray<{ key: string; source_resource_id: string }> };
      env_dotenv_template: string;
      env_entries: ReadonlyArray<{ key: string; sealed_blob: unknown }>;
    };
    expect(Object.keys(body.mcp_json.mcpServers)).toEqual(['acme-gh']);
    expect(body.env_manifest.keys).toHaveLength(1);
    expect(body.env_manifest.keys[0]).toMatchObject({
      key: 'GITHUB_TOKEN',
      source_resource_id: 'r-gh',
    });
    expect(body.env_dotenv_template).toContain('GITHUB_TOKEN=${GITHUB_TOKEN}');
    expect(body.env_entries).toHaveLength(1);
    expect(body.env_entries[0]!.sealed_blob).toBeDefined();
    // ZK : no cleartext anywhere.
    expect(JSON.stringify(body)).not.toContain('github_pat_supersecret');
  });

  it('returns 400 on invalid variant', async () => {
    seedBasicOrg();
    const mod = await importMcp();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/mcp', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org', variant: 'BAD VARIANT WITH SPACES' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /exports/cloud-resource-map', () => {
  beforeEach(() => {
    resetState();
  });

  it('emits a JSON metadata map with zero secrets', async () => {
    seedBasicOrg();
    state.resources = [
      {
        id: 'r-gh',
        organization_id: 'org-1',
        project_id: null,
        kind: 'github-org',
        scope: 'org',
        name: 'acme-gh',
        variant: null,
        provider_metadata: { org: 'acme' },
        secret_manager_id: 'sm-1',
      },
    ];
    const { bytea } = await blobBytea('github_pat_supersecret');
    state.access = [
      {
        id: 'a-1',
        resource_id: 'r-gh',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importMap();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/cloud-resource-map', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      organization_id: string;
      exported_at: string;
      resources: ReadonlyArray<{
        id: string;
        kind: string;
        access_keys: ReadonlyArray<{ key: string; usage: string }>;
        secret_manager: { kind: string; name: string };
        egress_hosts: ReadonlyArray<string>;
        mcp_fragment: unknown;
      }>;
    };
    expect(body.version).toBe(1);
    expect(body.organization_id).toBe('org-1');
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]!.kind).toBe('github-org');
    expect(body.resources[0]!.access_keys).toEqual([
      { key: 'GITHUB_TOKEN', usage: 'browser-only' },
    ]);
    expect(body.resources[0]!.secret_manager).toEqual({ kind: 'infisical', name: 'default' });
    expect(body.resources[0]!.egress_hosts).toContain('api.github.com');

    // ZK strict : cloud-resource-map MUST NOT carry any sealed_blob,
    // ciphertext, or cleartext.
    const json = JSON.stringify(body);
    expect(json).not.toContain('sealed_blob');
    expect(json).not.toContain('"ct"');
    expect(json).not.toContain('github_pat_supersecret');

    // Audit
    const auditRow = state.audit.find((r) => r.action === 'cloud_resource_map.exported');
    expect(auditRow).toBeDefined();
    expect(auditRow!.subject).toMatchObject({ resource_count: 1, access_key_count: 1 });
  });

  it('returns deterministic bytes for the same DB state (hors exported_at)', async () => {
    seedBasicOrg();
    state.resources = [
      {
        id: 'r-gh',
        organization_id: 'org-1',
        project_id: null,
        kind: 'github-org',
        scope: 'org',
        name: 'acme-gh',
        variant: null,
        provider_metadata: { org: 'acme' },
        secret_manager_id: 'sm-1',
      },
    ];
    const { bytea } = await blobBytea('s');
    state.access = [
      {
        id: 'a-1',
        resource_id: 'r-gh',
        key: 'GITHUB_TOKEN',
        sealed_blob: bytea,
        description: null,
        rotated_at: '2026-05-21T00:00:00Z',
      },
    ];
    const mod = await importMap();
    const ctx = () => ({ params: Promise.resolve({ orgId: 'acme' }) });
    const r1 = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/cloud-resource-map', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      ctx(),
    );
    const r2 = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/exports/cloud-resource-map', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      ctx(),
    );
    const b1 = (await r1.json()) as { exported_at: string; resources: unknown };
    const b2 = (await r2.json()) as { exported_at: string; resources: unknown };
    expect(JSON.stringify(b1.resources)).toBe(JSON.stringify(b2.resources));
  });
});
