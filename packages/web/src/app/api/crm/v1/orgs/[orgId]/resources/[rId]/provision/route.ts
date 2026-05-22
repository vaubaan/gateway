/**
 * `POST /api/crm/v1/orgs/:orgId/resources/:rId/provision`
 *
 * Spec §6.5 + §7.3 — book-keeping side of the provisioning workflow.
 * The browser has already called `admin.createChild(access, spec)` on
 * the provider API (with the admin cred unsealed transitorily, ZK
 * invariant spec §4). This endpoint records the new ProjectResource in
 * the CRM database — without ever seeing the child's cleartext token.
 *
 * Pre-conditions enforced server-side:
 *   - The session user has access to the org (RLS membership check).
 *   - The :rId resource exists, has `is_admin=true`, lives in the
 *     same org, and is of `kindClass='org-admin'`.
 *   - The child kind passed in the body is in `admin.manages`.
 *
 * On success: 201 with the inserted resource row + audit
 * `resource.provisioned`.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';

import {
  findDefaultSecretManager,
  findOrgIdBySlugOrId,
  getDb,
  type ResourceRow,
} from '@/lib/resources/db';
import { parseProvisionRequest, type ValidationError } from '@/lib/validation/provision';

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

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;

  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  // Fetch the admin resource — it must exist in this org, be is_admin,
  // and be of kindClass='org-admin'.
  const { data: adminRowRaw, error: adminErr } = (await db
    .from('resources')
    .select(
      'id, organization_id, project_id, admin_resource_id, provider_name, kind, scope, is_admin, name, variant, provider_ref, console_url, setup_docs_url, health_test_cmd, status, secret_manager_id, provider_metadata, provider_permissions, connection_status, connection_checked_at, connection_message, created_at, updated_at',
    )
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as {
    data: ResourceRow | null;
    error: { code?: string; message: string } | null;
  };

  if (adminErr) return errorResponse('database_error', 500);
  if (!adminRowRaw) return errorResponse('not_found', 404, 'admin resource not found');
  const adminRow = adminRowRaw;

  if (!adminRow.is_admin) {
    return errorResponse('forbidden', 403, 'target resource is not flagged is_admin');
  }
  const adminKind = findKind(adminRow.kind);
  if (!adminKind) {
    return errorResponse('database_error', 500, 'admin resource kind not in catalog');
  }
  if (adminKind.kindClass !== 'org-admin') {
    return errorResponse('forbidden', 403, 'admin resource kindClass is not org-admin');
  }

  // Manages list comes only from OrgResourceAdminKind.
  const manages = (adminKind as { manages?: ReadonlyArray<string> }).manages ?? [];

  const raw = await req.text();
  const parsed = parseProvisionRequest(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  // Verify the child kind is in admin.manages.
  if (!manages.includes(input.childKind)) {
    return errorResponse(
      'invalid_field',
      400,
      `childKind ${input.childKind} is not in admin.manages (${manages.join(', ')})`,
    );
  }

  const childKind = findKind(input.childKind);
  if (!childKind) {
    return errorResponse('unknown_kind', 400, `unknown child kind: ${input.childKind}`);
  }
  if (childKind.kindClass !== 'project') {
    return errorResponse(
      'invalid_field',
      400,
      'provisioning is only supported for kindClass=project',
    );
  }

  // Resolve secret_manager_id: default of the org.
  const sm = await findDefaultSecretManager(db, org.id);
  if (!sm) {
    return errorResponse(
      'no_default_secret_manager',
      400,
      'org has no default secret_manager; create one first (spec §6.2)',
    );
  }

  const insertRow = {
    organization_id: org.id,
    project_id: input.projectId,
    admin_resource_id: adminRow.id,
    provider_name: childKind.provider,
    kind: childKind.id,
    scope: 'project' as const,
    is_admin: false,
    name: input.name,
    variant: input.variant,
    provider_ref: input.providerRef,
    secret_manager_id: sm.id,
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
    if (error.code === '23505') {
      return errorResponse('conflict', 409, 'resource name already used in this project');
    }
    if (error.code === '23514') {
      return errorResponse(
        'check_constraint_violation',
        400,
        'request violates DB CHECK constraint (spec §3.1)',
      );
    }
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }

  if (!insertedRaw) return errorResponse('forbidden', 403);
  const inserted = insertedRaw;

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.provisioned',
    scope: {
      resource_id: inserted.id,
      admin_resource_id: adminRow.id,
      child_kind: childKind.id,
    },
    subject: {
      name: inserted.name,
      provider_ref: inserted.provider_ref,
    },
  });

  return jsonResponse({ resource: inserted, resource_id: inserted.id }, 201);
}
