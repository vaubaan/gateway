/**
 * `/api/crm/v1/orgs/:orgId/resources/:rId` — single Resource endpoints.
 *
 * - `GET`    : detail (any org member, RLS gated).
 * - `PATCH`  : update mutable metadata (org admin only).
 * - `DELETE` : detach (org admin only). Spec §6.5 explicitly distinguishes
 *              this "detach the Vauban row" from
 *              `/destroy-cloud-resource` (which also calls the parent
 *              admin's `destroyChild`). Phase 4 only ships the detach.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.3, §6.5.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, getDb, type ResourceRow } from '@/lib/resources/db';
import { type ValidationError, parseUpdateResource } from '@/lib/validation/resources';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly orgId: string; readonly rId: string }>;
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

const RESOURCE_COLS =
  'id, organization_id, project_id, admin_resource_id, provider_name, kind, scope, is_admin, name, variant, provider_ref, console_url, setup_docs_url, health_test_cmd, status, secret_manager_id, provider_metadata, provider_permissions, connection_status, connection_checked_at, connection_message, created_at, updated_at';

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const { data, error } = (await db
    .from('resources')
    .select(RESOURCE_COLS)
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as {
    data: ResourceRow | null;
    error: { code?: string; message: string } | null;
  };

  if (error) return errorResponse('database_error', 500);
  if (!data) return errorResponse('not_found', 404);
  return jsonResponse({ resource: data }, 200);
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseUpdateResource(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  const updateRow: Record<string, unknown> = {};
  if (input.name !== undefined) updateRow.name = input.name;
  if (input.variant !== undefined) updateRow.variant = input.variant;
  if (input.providerRef !== undefined) updateRow.provider_ref = input.providerRef;
  if (input.consoleUrl !== undefined) updateRow.console_url = input.consoleUrl;
  if (input.setupDocsUrl !== undefined) updateRow.setup_docs_url = input.setupDocsUrl;
  if (input.metadata !== undefined) updateRow.provider_metadata = input.metadata;
  if (input.status !== undefined) updateRow.status = input.status;

  if (Object.keys(updateRow).length === 0) {
    return errorResponse('invalid_field', 400, 'PATCH body has no updatable field');
  }

  const { data, error } = (await db
    .from('resources')
    .update(updateRow)
    .eq('organization_id', org.id)
    .eq('id', rId)
    .select(RESOURCE_COLS)
    .maybeSingle()) as {
    data: ResourceRow | null;
    error: { code?: string; message: string } | null;
  };

  if (error) {
    if (error.code === '23514') {
      return errorResponse(
        'check_constraint_violation',
        400,
        'request violates DB CHECK constraint (spec §3.1)',
      );
    }
    if (error.code === '23505') return errorResponse('conflict', 409, 'resource name already used');
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }

  // RLS update returning 0 rows: either the row doesn't exist OR the user
  // is not admin. We can't distinguish here without an extra read, so we
  // probe the row to differentiate 404 vs 403 (defensive UX).
  if (!data) {
    const { data: probe } = (await db
      .from('resources')
      .select('id')
      .eq('organization_id', org.id)
      .eq('id', rId)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };
    if (probe) return errorResponse('forbidden', 403);
    return errorResponse('not_found', 404);
  }

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.updated',
    scope: { resource_id: data.id, kind: data.kind, scope: data.scope },
    subject: { fields: Object.keys(updateRow) },
  });

  return jsonResponse({ resource: data }, 200);
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  // Snapshot the row first for the audit subject + to distinguish 404
  // (row gone) from 403 (RLS denied the delete) after the fact.
  const { data: existing } = (await db
    .from('resources')
    .select('id, kind, scope, name, variant')
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as {
    data: { id: string; kind: string; scope: string; name: string; variant: string | null } | null;
    error: unknown;
  };
  if (!existing) return errorResponse('not_found', 404);

  const { error } = await db.from('resources').delete().eq('organization_id', org.id).eq('id', rId);

  if (error) {
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }

  // Probe to detect RLS-silent denial (delete with 0 rows affected
  // surfaces no error under PostgREST).
  const { data: stillThere } = (await db
    .from('resources')
    .select('id')
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };
  if (stillThere) return errorResponse('forbidden', 403);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.deleted',
    scope: { resource_id: existing.id, kind: existing.kind, scope: existing.scope },
    subject: { name: existing.name, variant: existing.variant },
  });

  return jsonResponse({ ok: true }, 200);
}
