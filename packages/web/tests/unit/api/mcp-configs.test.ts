/**
 * Unit tests for the Phase 7 wave A MCP regen endpoints:
 *
 *   - GET  /api/crm/v1/orgs/:orgId/mcp-configs
 *   - POST /api/crm/v1/orgs/:orgId/mcp-configs/regenerate
 *
 * The Supabase client is faked with an in-memory store. We assert:
 *
 *   - compose + resolve-scope union (project rows + org-scope rows).
 *   - UPSERT on (org, project_id, variant) with NULL-aware lookup.
 *   - Idempotency : second POST with identical state is a no-op,
 *     `generated_at` unchanged, no audit row.
 *   - Audit subject carries the snapshot hash + counts, never the
 *     snapshot itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
interface McpConfigStoreRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  variant: string | null;
  mcp_snapshot: Record<string, unknown>;
  env_snapshot: Record<string, unknown>;
  generated_at: string;
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
  mcpConfigs: McpConfigStoreRow[];
  audit: AuditRow[];
}

const state: FakeState = {
  user: null,
  orgs: [],
  resources: [],
  mcpConfigs: [],
  audit: [],
};

function resetState(): void {
  state.user = null;
  state.orgs = [];
  state.resources = [];
  state.mcpConfigs = [];
  state.audit = [];
}

interface Filter {
  kind: 'eq' | 'is' | 'or' | 'order';
  col?: string;
  val?: unknown;
  filter?: string;
}

function applyFilters<T extends Record<string, unknown>>(rows: T[], filters: Filter[]): T[] {
  let out = rows.slice();
  for (const f of filters) {
    if (f.kind === 'eq') out = out.filter((r) => r[f.col!] === f.val);
    else if (f.kind === 'is') out = out.filter((r) => r[f.col!] === null);
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
    case 'mcp_configs':
      return state.mcpConfigs as unknown as Array<Record<string, unknown>>;
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
        upsert(row: Record<string, unknown>, _opts?: { onConflict?: string }) {
          if (table !== 'mcp_configs') throw new Error(`upsert unsupported on ${table}`);
          const idx = state.mcpConfigs.findIndex(
            (r) =>
              r.organization_id === row.organization_id &&
              r.project_id === (row.project_id as string | null) &&
              r.variant === (row.variant as string | null),
          );
          const stored: McpConfigStoreRow = {
            id: idx >= 0 ? state.mcpConfigs[idx]!.id : `mc-${state.mcpConfigs.length + 1}`,
            organization_id: row.organization_id as string,
            project_id: (row.project_id as string | null) ?? null,
            variant: (row.variant as string | null) ?? null,
            mcp_snapshot: row.mcp_snapshot as Record<string, unknown>,
            env_snapshot: row.env_snapshot as Record<string, unknown>,
            generated_at: (row.generated_at as string) ?? new Date().toISOString(),
          };
          if (idx >= 0) state.mcpConfigs[idx] = stored;
          else state.mcpConfigs.push(stored);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: stored, error: null }),
            }),
          };
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeDb()),
}));

interface ListHandler {
  GET(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}
interface RegenerateHandler {
  POST(req: Request, ctx: { params: Promise<{ orgId: string }> }): Promise<Response>;
}

async function importList(): Promise<ListHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/mcp-configs/route');
  return mod as ListHandler;
}
async function importRegen(): Promise<RegenerateHandler> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/[orgId]/mcp-configs/regenerate/route');
  return mod as RegenerateHandler;
}

function seedOrgWithGhAndVercel(): void {
  state.user = { id: 'user-1' };
  state.orgs = [{ id: 'org-1', slug: 'acme' }];
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
      id: 'r-v',
      organization_id: 'org-1',
      project_id: null,
      kind: 'vercel-team',
      scope: 'org',
      name: 'acme-vercel',
      variant: null,
      provider_metadata: { teamSlug: 'acme' },
      secret_manager_id: 'sm-1',
    },
  ];
}

describe('GET /mcp-configs', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 without a session', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importList();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs'), {
      params: Promise.resolve({ orgId: 'acme' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the org is not visible (RLS-equivalent)', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [];
    const mod = await importList();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/missing/mcp-configs'), {
      params: Promise.resolve({ orgId: 'missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns the list of existing mcp_configs', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    state.mcpConfigs = [
      {
        id: 'mc-1',
        organization_id: 'org-1',
        project_id: null,
        variant: null,
        mcp_snapshot: { mcpServers: {} },
        env_snapshot: { keys: [] },
        generated_at: '2026-05-21T10:00:00Z',
      },
    ];
    const mod = await importList();
    const res = await mod.GET(new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs'), {
      params: Promise.resolve({ orgId: 'acme' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mcp_configs: ReadonlyArray<{ id: string }>;
    };
    expect(body.mcp_configs).toHaveLength(1);
    expect(body.mcp_configs[0]?.id).toBe('mc-1');
  });
});

describe('POST /mcp-configs/regenerate', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 400 when scope is missing', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importRegen();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when scope=project but scopeId is missing', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    const mod = await importRegen();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({ scope: 'project' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(400);
  });

  it('composes a snapshot from the org-scoped resources and UPSERTs', async () => {
    seedOrgWithGhAndVercel();
    const mod = await importRegen();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      regenerated: boolean;
      mcp_config: { mcp_snapshot: { mcpServers: Record<string, unknown> } };
      hash: string;
    };
    expect(body.regenerated).toBe(true);
    expect(Object.keys(body.mcp_config.mcp_snapshot.mcpServers).sort()).toEqual([
      'acme-gh',
      'acme-vercel',
    ]);
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.mcpConfigs).toHaveLength(1);
    expect(state.audit.map((r) => r.action)).toContain('mcp_config.regenerated');
    const auditRow = state.audit[0]!;
    expect(auditRow.subject).toMatchObject({
      hash: body.hash,
      resource_count: 2,
      mcp_servers_count: 2,
    });
    // ZK invariant : audit subject must not contain the snapshot itself.
    expect(JSON.stringify(auditRow.subject)).not.toContain('mcpServers');
  });

  it('is idempotent: a second call with the same state is a no-op (no audit row)', async () => {
    seedOrgWithGhAndVercel();
    const mod = await importRegen();
    const ctx = { params: Promise.resolve({ orgId: 'acme' }) };
    const r1 = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      ctx,
    );
    expect(r1.status).toBe(200);
    const generatedAtAfterFirst = state.mcpConfigs[0]!.generated_at;
    const auditCountAfterFirst = state.audit.length;

    // Second call — same input, same state.
    const r2 = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { regenerated: boolean };
    expect(body2.regenerated).toBe(false);
    expect(state.mcpConfigs[0]!.generated_at).toBe(generatedAtAfterFirst);
    expect(state.audit.length).toBe(auditCountAfterFirst);
  });

  it('regenerates (write + audit) when a Resource changes', async () => {
    seedOrgWithGhAndVercel();
    const mod = await importRegen();
    const r1 = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(r1.status).toBe(200);
    const auditCountAfterFirst = state.audit.length;

    // Add a new resource.
    state.resources.push({
      id: 'r-sb',
      organization_id: 'org-1',
      project_id: null,
      kind: 'supabase-org',
      scope: 'org',
      name: 'acme-supabase',
      variant: null,
      provider_metadata: { orgSlug: 'acme' },
      secret_manager_id: 'sm-1',
    });

    const r2 = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({ scope: 'org' }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as {
      regenerated: boolean;
      mcp_config: { mcp_snapshot: { mcpServers: Record<string, unknown> } };
    };
    expect(body2.regenerated).toBe(true);
    expect(Object.keys(body2.mcp_config.mcp_snapshot.mcpServers).sort()).toEqual([
      'acme-gh',
      'acme-supabase',
      'acme-vercel',
    ]);
    expect(state.audit.length).toBe(auditCountAfterFirst + 1);
  });

  it('project-scoped regen unions project rows with the org-scope rows', async () => {
    state.user = { id: 'user-1' };
    state.orgs = [{ id: 'org-1', slug: 'acme' }];
    // 1 org-scope github
    // 1 project-scope github-repo (no mcpFragment — should be skipped)
    // 1 project-scope supabase-org? supabase-org is org-scope, so use a
    //   different mix: stick with org-scope + project-scope kind.
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
        id: 'r-repo',
        organization_id: 'org-1',
        project_id: '00000000-0000-0000-0000-000000000001',
        kind: 'github-repo',
        scope: 'project',
        name: 'frontend',
        variant: 'staging',
        provider_metadata: { org: 'acme', repo: 'frontend' },
        secret_manager_id: 'sm-1',
      },
    ];
    const mod = await importRegen();
    const res = await mod.POST(
      new Request('http://localhost/api/crm/v1/orgs/acme/mcp-configs/regenerate', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'project',
          scopeId: '00000000-0000-0000-0000-000000000001',
          variant: 'staging',
        }),
      }),
      { params: Promise.resolve({ orgId: 'acme' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      regenerated: boolean;
      mcp_config: { mcp_snapshot: { mcpServers: Record<string, unknown> } };
    };
    // github-repo has no mcpFragment → only the github-org survives.
    expect(Object.keys(body.mcp_config.mcp_snapshot.mcpServers)).toEqual(['acme-gh']);
    expect(state.mcpConfigs[0]!.project_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(state.mcpConfigs[0]!.variant).toBe('staging');
  });
});
