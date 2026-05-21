/**
 * Unit tests for `POST /api/crm/v1/orgs` (Phase 4 wave C — onboarding).
 *
 * The session client + service-role client are both faked. We assert:
 * - 401 without a session,
 * - 400 on invalid slug / missing fields,
 * - 409 on existing slug,
 * - 201 happy path : org + admin membership + placeholder
 *   secret_managers default + audit `org.created`.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §11.1.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface OrgStoreRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}
interface MemberStoreRow {
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
}
interface SmStoreRow {
  readonly organization_id: string;
  readonly kind: string;
  readonly name: string;
  readonly is_default: boolean;
}
interface AuditStoreRow {
  readonly organization_id: string | null;
  readonly action: string;
  readonly subject: Record<string, unknown>;
}

interface FakeState {
  user: { id: string } | null;
  orgs: OrgStoreRow[];
  members: MemberStoreRow[];
  secretManagers: SmStoreRow[];
  audits: AuditStoreRow[];
}

const state: FakeState = {
  user: null,
  orgs: [],
  members: [],
  secretManagers: [],
  audits: [],
};

function reset(): void {
  state.user = { id: 'user-1' };
  state.orgs = [];
  state.members = [];
  state.secretManagers = [];
  state.audits = [];
}

function buildClient(): unknown {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: state.user } }),
    },
    from(table: string) {
      return {
        select: (_cols: string) => ({
          eq: (col: string, val: string) => ({
            maybeSingle: () => {
              if (table === 'organizations') {
                const found = state.orgs.find(
                  (o) => (o as unknown as Record<string, unknown>)[col] === val,
                );
                return Promise.resolve({ data: found ?? null, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
        }),
        insert(row: Record<string, unknown>) {
          if (table === 'organizations') {
            const slug = row.slug as string;
            if (state.orgs.some((o) => o.slug === slug)) {
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: '23505', message: 'duplicate slug' },
                    }),
                }),
              };
            }
            const created: OrgStoreRow = {
              id: `org-${state.orgs.length + 1}`,
              slug,
              name: row.name as string,
            };
            state.orgs.push(created);
            const thenable = Promise.resolve({ data: created, error: null });
            return Object.assign(thenable, {
              select: () => ({ single: () => Promise.resolve({ data: created, error: null }) }),
            });
          }
          if (table === 'org_members') {
            state.members.push({
              organization_id: row.organization_id as string,
              user_id: row.user_id as string,
              role: row.role as string,
            });
            return Promise.resolve({ data: null, error: null });
          }
          if (table === 'secret_managers') {
            state.secretManagers.push({
              organization_id: row.organization_id as string,
              kind: row.kind as string,
              name: row.name as string,
              is_default: row.is_default === true,
            });
            return Promise.resolve({ data: null, error: null });
          }
          if (table === 'audit_log') {
            state.audits.push({
              organization_id: (row.organization_id as string | null) ?? null,
              action: row.action as string,
              subject: (row.subject as Record<string, unknown> | undefined) ?? {},
            });
            return Promise.resolve({ data: null, error: null });
          }
          throw new Error(`unexpected insert into ${table}`);
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(buildClient()),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => buildClient(),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';

interface OrgsRoute {
  POST(req: Request): Promise<Response>;
}

async function importRoute(): Promise<OrgsRoute> {
  const mod: unknown = await import('@/app/api/crm/v1/orgs/route');
  return mod as OrgsRoute;
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/crm/v1/orgs', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/crm/v1/orgs', () => {
  beforeEach(() => {
    reset();
  });

  it('returns 401 without a session', async () => {
    state.user = null;
    const mod = await importRoute();
    const res = await mod.POST(postReq({ slug: 'acme', name: 'Acme' }));
    expect(res.status).toBe(401);
  });

  it('refuses an invalid slug', async () => {
    const mod = await importRoute();
    const res = await mod.POST(postReq({ slug: 'ACME', name: 'Acme' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.error).toBe('invalid_field');
  });

  it('refuses an empty name', async () => {
    const mod = await importRoute();
    const res = await mod.POST(postReq({ slug: 'acme', name: '  ' }));
    expect(res.status).toBe(400);
  });

  it('creates org + admin membership + default secret_manager + audit', async () => {
    const mod = await importRoute();
    const res = await mod.POST(postReq({ slug: 'acme', name: 'Acme Corp' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { org: { id: string; slug: string; name: string } };
    expect(body.org.slug).toBe('acme');
    expect(state.orgs).toHaveLength(1);
    expect(state.members).toHaveLength(1);
    expect(state.members[0]?.role).toBe('admin');
    expect(state.members[0]?.user_id).toBe('user-1');
    expect(state.secretManagers).toHaveLength(1);
    expect(state.secretManagers[0]?.is_default).toBe(true);
    expect(state.secretManagers[0]?.kind).toBe('placeholder');
    expect(state.audits.map((a) => a.action)).toContain('org.created');
  });

  it('returns 409 when the slug already exists', async () => {
    state.orgs = [{ id: 'org-1', slug: 'acme', name: 'preexisting' }];
    const mod = await importRoute();
    const res = await mod.POST(postReq({ slug: 'acme', name: 'Acme Corp' }));
    expect(res.status).toBe(409);
  });
});
