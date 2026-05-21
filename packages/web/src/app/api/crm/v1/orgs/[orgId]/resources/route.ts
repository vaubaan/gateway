/**
 * `/api/crm/v1/orgs/:orgId/resources` — collection endpoints.
 *
 * - `GET`  : list Resources visible to the user (RLS `is_org_member`),
 *           with the filters spec §6.3.
 * - `POST` : register a new Resource (admin-only via RLS
 *           `resources_insert_admin`). The blob itself lands later via
 *           `PUT /resources/:rId/access/:key` (spec §7.1 step 5).
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.3, §7.1.
 *
 * No service-role: every query carries the user's session and RLS does
 * the gating. The handler echoes 400 with a stable `code` string on
 * validation errors, 403 on RLS denial (mapped from PostgREST 42501
 * / generic insert failure on RLS), 404 when the org is not visible to
 * the user (slug or uuid both supported).
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';

import {
  findDefaultSecretManager,
  findOrgIdBySlugOrId,
  getDb,
  type ResourceRow,
} from '@/lib/resources/db';
import {
  type ValidationError,
  parseListFilters,
  parseRegisterResource,
} from '@/lib/validation/resources';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly orgId: string }>;
}

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

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const url = new URL(req.url);
  const filters = parseListFilters(url.searchParams);
  if (!filters.ok) return validationErrorResponse(filters.error);

  let query = db
    .from('resources')
    .select(
      'id, organization_id, project_id, admin_resource_id, provider_name, kind, scope, is_admin, name, variant, provider_ref, console_url, setup_docs_url, health_test_cmd, status, secret_manager_id, provider_metadata, provider_permissions, connection_status, connection_checked_at, connection_message, created_at, updated_at',
    )
    .eq('organization_id', org.id);

  if (filters.value.scope) query = query.eq('scope', filters.value.scope);
  if (filters.value.projectId) query = query.eq('project_id', filters.value.projectId);
  if (filters.value.variant) query = query.eq('variant', filters.value.variant);
  if (filters.value.kind) query = query.eq('kind', filters.value.kind);
  if (filters.value.isAdmin !== undefined) query = query.eq('is_admin', filters.value.isAdmin);

  const { data, error } = (await query.order('created_at', { ascending: false })) as {
    data: ReadonlyArray<ResourceRow> | null;
    error: { code?: string; message: string } | null;
  };

  if (error) return errorResponse('database_error', 500);
  return jsonResponse({ resources: data ?? [] }, 200);
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseRegisterResource(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  const kind = findKind(input.kind);
  if (!kind) return errorResponse('unknown_kind', 400, `unknown kind: ${input.kind}`);

  // Resolve secret_manager_id: explicit one or org default.
  let secretManagerId = input.secretManagerId;
  if (secretManagerId === null) {
    const def = await findDefaultSecretManager(db, org.id);
    if (!def) {
      return errorResponse(
        'no_default_secret_manager',
        400,
        'org has no default secret_manager; pass secret_manager_id explicitly or create one (spec §6.2)',
      );
    }
    secretManagerId = def.id;
  }

  const isAdmin = kind.kindClass === 'org-admin';

  const insertRow = {
    organization_id: org.id,
    project_id: input.projectId,
    admin_resource_id: input.adminResourceId,
    provider_name: kind.provider,
    kind: kind.id,
    scope: input.scope,
    is_admin: isAdmin,
    name: input.name,
    variant: input.variant,
    provider_ref: input.providerRef,
    console_url: input.consoleUrl,
    setup_docs_url: input.setupDocsUrl,
    secret_manager_id: secretManagerId,
    provider_metadata: input.metadata,
    status: 'pending',
  };

  const { data: insertedRaw, error } = (await db
    .from('resources')
    .insert(insertRow)
    .select(
      'id, organization_id, project_id, admin_resource_id, provider_name, kind, scope, is_admin, name, variant, provider_ref, console_url, setup_docs_url, health_test_cmd, status, secret_manager_id, provider_metadata, provider_permissions, connection_status, connection_checked_at, connection_message, created_at, updated_at',
    )
    .single()) as {
    data: ResourceRow | null;
    error: { code?: string; message: string } | null;
  };

  if (error) {
    // 23505 = unique_violation (organization_id, project_id, name).
    if (error.code === '23505') return errorResponse('conflict', 409, 'resource name already used');
    // 23514 = check_violation (slug regex, scope mismatch, admin-only-on-project, …)
    if (error.code === '23514') {
      return errorResponse(
        'check_constraint_violation',
        400,
        'request violates DB CHECK constraint (spec §3.1)',
      );
    }
    // 42501 = insufficient_privilege (RLS) on insert.
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }

  if (!insertedRaw) return errorResponse('forbidden', 403);
  const inserted = insertedRaw;

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.registered',
    scope: { resource_id: inserted.id, kind: inserted.kind, scope: inserted.scope },
    subject: { name: inserted.name, variant: inserted.variant },
  });

  return jsonResponse({ resource: inserted }, 201);
}
