/**
 * `POST /api/crm/v1/orgs` — onboarding flow (Phase 4 wave C).
 *
 * Creates an organization + the matching `org_members(role='admin')`
 * row for `auth.uid()` + a `secret_managers` default placeholder so the
 * later `POST /orgs/:orgId/resources` doesn't trip the
 * `no_default_secret_manager` 400.
 *
 * RLS on `organizations` does NOT allow inserts via the
 * authenticated role (only `update`/`delete` policies exist for
 * admins; no `insert` policy means PostgREST denies the operation).
 * Bootstrapping a new org therefore requires the service-role: it's
 * the rare exception to the "no service-role in API handlers" rule
 * (CLAUDE.md: "Service_role est admis pour les migrations OOB").
 * We isolate it here, audit every call, and immediately drop down to
 * the session's RLS for the membership row insert.
 *
 * The Infisical Phase 5 will swap the placeholder `secret_managers`
 * row for a real one. Phase 4 doesn't ship an Infisical adapter, so
 * we insert `kind='placeholder', is_default=true` — enough to satisfy
 * `resources.secret_manager_id NOT NULL` and the
 * `secret_managers_one_default_per_org` partial unique index.
 *
 * Spec §3.1 (DB shape), §11.1 (UX), §6.2 (SecretManagers REST).
 */

import { type NextRequest, NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { parseCreateOrg, type ValidationError } from '@/lib/validation/orgs';

export const dynamic = 'force-dynamic';

function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function jsonResponse(body: unknown, status: number): NextResponse {
  return noStore(NextResponse.json(body, { status }));
}

function errorResponse(code: string, status: number, message?: string): NextResponse {
  return jsonResponse({ error: code, ...(message !== undefined ? { message } : {}) }, status);
}

function validationErrorResponse(err: ValidationError): NextResponse {
  return errorResponse(err.code, 400, err.message);
}

interface DbResult<T> {
  readonly data: T;
  readonly error: { code?: string; message: string } | null;
}

interface NarrowedDb {
  auth: {
    getUser(): Promise<{ data: { user: { id: string; email?: string | null } | null } }>;
  };
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): Promise<DbResult<unknown>>;
      };
    };
    insert(row: Record<string, unknown>): {
      select(cols: string): {
        single(): Promise<DbResult<unknown>>;
      };
    } & Promise<DbResult<unknown>>;
  };
}

async function getServiceRoleClient(): Promise<NarrowedDb> {
  // Service-role client is only used to (a) insert the organization row
  // (no RLS insert policy), and (b) seed the default secret_manager.
  // Membership insert is done through the user's session afterwards so
  // RLS path is exercised.
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY missing — onboarding bootstrap requires the service-role.',
    );
  }
  const client: unknown = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client as NarrowedDb;
}

interface OrgRowOut {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = (await createSupabaseServerClient()) as unknown as NarrowedDb;
  const { data: userData } = await session.auth.getUser();
  const user = userData.user;
  if (!user) return errorResponse('unauthorized', 401);

  const raw = await req.text();
  const parsed = parseCreateOrg(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const { slug, name } = parsed.value;

  const service = await getServiceRoleClient();

  // Detect a pre-existing slug up-front so we surface 409 even if the
  // race-condition path hits the unique constraint downstream.
  const { data: existing } = (await service
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle()) as DbResult<OrgRowOut | null>;
  if (existing) return errorResponse('conflict', 409, 'slug already used');

  // 1. Insert the org row (service-role only — no RLS insert policy).
  const { data: orgRaw, error: orgErr } = (await service
    .from('organizations')
    .insert({ slug, name })
    .select('id, slug, name')
    .single()) as DbResult<OrgRowOut | null>;
  if (orgErr) {
    if (orgErr.code === '23505') return errorResponse('conflict', 409, 'slug already used');
    return errorResponse('database_error', 500, orgErr.message);
  }
  if (!orgRaw) return errorResponse('database_error', 500, 'org insert returned no row');
  const org = orgRaw;

  // 2. Insert the admin membership (still service-role — the user
  //    couldn't insert via RLS because `is_org_admin(...)` returns
  //    false before the row exists).
  const memberRes = await service.from('org_members').insert({
    organization_id: org.id,
    user_id: user.id,
    role: 'admin',
  });
  if (memberRes.error) return errorResponse('database_error', 500, memberRes.error.message);

  // 3. Seed a placeholder default secret_manager so subsequent
  //    /resources POST doesn't trip `no_default_secret_manager`.
  //    Phase 5 (Infisical) will replace this row.
  const smRes = await service.from('secret_managers').insert({
    organization_id: org.id,
    kind: 'placeholder',
    name: 'default',
    is_default: true,
    config: { note: 'placeholder until Phase 5 Infisical' },
  });
  if (smRes.error) return errorResponse('database_error', 500, smRes.error.message);

  // 4. Audit. The actor is the user; the org_id is the row we just
  //    created. We go via the user's session so RLS
  //    `audit_log_select_member` will let them read this entry back.
  await session.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: user.id,
    action: 'org.created',
    scope: { org_id: org.id, slug: org.slug },
    subject: { name: org.name },
  });

  return jsonResponse({ org }, 201);
}
