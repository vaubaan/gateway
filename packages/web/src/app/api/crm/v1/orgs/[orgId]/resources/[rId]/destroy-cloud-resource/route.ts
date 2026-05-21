/**
 * `DELETE /api/crm/v1/orgs/:orgId/resources/:rId/destroy-cloud-resource`
 *
 * Spec §6.5 + §7.3 — book-keeping side of the destroy workflow.
 *
 * Important: this endpoint does NOT call the provider's destroy API.
 * The browser MUST have already invoked `admin.destroyChild(access,
 * providerRef)` (cleartext admin cred unsealed transitorily, ZK
 * invariant spec §4). This endpoint deletes the CRM row + audits the
 * cloud-side destruction.
 *
 * Pre-conditions:
 *   - The resource exists and is scope='project'.
 *   - The resource has a non-null admin_resource_id (it was
 *     provisioned via an admin).
 *
 * 409 if scope='org' or admin_resource_id is null — those rows go
 * through the regular DELETE /resources/:rId path (Phase 4).
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, findResourceByOrgAndId, getDb } from '@/lib/resource-access/db';

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

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;

  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  // We need scope + admin_resource_id to gate the workflow — pull a
  // wider row than findResourceByOrgAndId would.
  const { data: resourceRow } = (await db
    .from('resources')
    .select('id, organization_id, kind, scope, admin_resource_id, name, provider_ref, project_id')
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as {
    data: {
      id: string;
      organization_id: string;
      kind: string;
      scope: 'org' | 'project';
      admin_resource_id: string | null;
      name: string;
      provider_ref: string | null;
      project_id: string | null;
    } | null;
    error: { message: string } | null;
  };

  if (!resourceRow) return errorResponse('not_found', 404);

  if (resourceRow.scope !== 'project') {
    return errorResponse(
      'conflict',
      409,
      'destroy-cloud-resource is only valid for project-scoped resources',
    );
  }
  if (!resourceRow.admin_resource_id) {
    return errorResponse(
      'conflict',
      409,
      'destroy-cloud-resource requires an admin_resource_id (resource was not admin-provisioned)',
    );
  }

  // Hard-confirm via existing resource lookup as a sanity check.
  const existing = await findResourceByOrgAndId(db, org.id, rId);
  if (!existing) return errorResponse('not_found', 404);

  // Snapshot for audit before we delete.
  const auditScope = {
    resource_id: rId,
    kind: resourceRow.kind,
    admin_resource_id: resourceRow.admin_resource_id,
    project_id: resourceRow.project_id,
  };
  const auditSubject = {
    name: resourceRow.name,
    provider_ref: resourceRow.provider_ref,
  };

  // Delete via RLS — admin-only. Cascade removes resource_access rows.
  const delResult = (await db
    .from('resources')
    .delete()
    .eq('organization_id', org.id)
    .eq('id', rId)) as { data: unknown; error: { code?: string; message: string } | null };

  if (delResult.error) {
    if (delResult.error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }

  // Probe for RLS-silent denial.
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
    action: 'resource.destroyed-cloud-side',
    scope: auditScope,
    subject: auditSubject,
  });

  return jsonResponse({ ok: true }, 200);
}
