/**
 * `/api/crm/v1/orgs/:orgId/secret-managers/:smId` — single-SM endpoints (spec §6.2).
 *
 * - `GET`    : detail (any org member, RLS gated).
 * - `PATCH`  : set default, rename, rotate auth_sealed_blob.
 * - `DELETE` : refuse if `is_default=true` or if any `resources` row
 *              references this SM (DB `on delete restrict` would already
 *              error, but we surface a clean 409 with the count).
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.2.
 */

import { type NextRequest, NextResponse } from 'next/server';

import {
  findOrgIdBySlugOrId,
  getDb,
  sealedAuthToBytea,
  type SecretManagerRow,
} from '@/lib/secret-managers/db';
import { parseUpdateSecretManager, type ValidationError } from '@/lib/validation/secret-managers';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly orgId: string; readonly smId: string }>;
}

const SM_COLS = 'id, organization_id, kind, name, is_default, config, created_at';

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

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, smId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const { data, error } = (await db
    .from('secret_managers')
    .select(SM_COLS)
    .eq('organization_id', org.id)
    .eq('id', smId)
    .maybeSingle()) as {
    data: SecretManagerRow | null;
    error: { code?: string; message: string } | null;
  };
  if (error) return errorResponse('database_error', 500);
  if (!data) return errorResponse('not_found', 404);
  return jsonResponse({ secret_manager: data }, 200);
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, smId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseUpdateSecretManager(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  // If switching is_default=true, unset other defaults first.
  if (input.is_default === true) {
    const unsetResult = await db
      .from('secret_managers')
      .update({ is_default: false })
      .eq('organization_id', org.id)
      .eq('is_default', true)
      .select('id');
    const unsetErr = unsetResult.error;
    if (unsetErr) {
      if (unsetErr.code === '42501') return errorResponse('forbidden', 403);
      return errorResponse('database_error', 500, unsetErr.message);
    }
  }

  const updateRow: Record<string, unknown> = {};
  if (input.name !== undefined) updateRow.name = input.name;
  if (input.is_default !== undefined) updateRow.is_default = input.is_default;
  if (input.config !== undefined) updateRow.config = input.config;
  if (input.auth_sealed_blob !== undefined) {
    updateRow.auth_sealed_blob = sealedAuthToBytea(input.auth_sealed_blob);
  }

  const { data, error } = (await db
    .from('secret_managers')
    .update(updateRow)
    .eq('organization_id', org.id)
    .eq('id', smId)
    .select(SM_COLS)
    .maybeSingle()) as {
    data: SecretManagerRow | null;
    error: { code?: string; message: string } | null;
  };

  if (error) {
    if (error.code === '23505') return errorResponse('conflict', 409, 'name already used in org');
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500, error.message);
  }

  if (!data) {
    // Distinguish 404 vs 403 (RLS silent denial).
    const { data: probe } = (await db
      .from('secret_managers')
      .select('id')
      .eq('organization_id', org.id)
      .eq('id', smId)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };
    if (probe) return errorResponse('forbidden', 403);
    return errorResponse('not_found', 404);
  }

  // Audit. The subject summarises which fields changed, NEVER the
  // auth_sealed_blob bytes.
  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'secret_manager.updated',
    scope: { secret_manager_id: data.id, kind: data.kind, name: data.name },
    subject: {
      fields: Object.keys(updateRow),
      ...(input.auth_sealed_blob !== undefined
        ? { recipient_count: input.auth_sealed_blob.recipients.length }
        : {}),
    },
  });

  return jsonResponse({ secret_manager: data }, 200);
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, smId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  // Snapshot the row first.
  const { data: existing } = (await db
    .from('secret_managers')
    .select(SM_COLS)
    .eq('organization_id', org.id)
    .eq('id', smId)
    .maybeSingle()) as {
    data: SecretManagerRow | null;
    error: unknown;
  };
  if (!existing) return errorResponse('not_found', 404);

  if (existing.is_default) {
    return errorResponse(
      'is_default',
      409,
      'cannot delete the default secret_manager; set another as default first',
    );
  }

  // Count referencing resources — RESTRICT cascade would error with
  // 23503, but we surface a clean 409 with the count for the UI.
  const { data: refs } = (await db
    .from('resources')
    .select('id')
    .eq('organization_id', org.id)
    .eq('secret_manager_id', smId)) as {
    data: ReadonlyArray<{ id: string }> | null;
    error: unknown;
  };
  if (refs && refs.length > 0) {
    return jsonResponse(
      {
        error: 'referenced',
        message: `secret_manager is referenced by ${String(refs.length)} resource(s); reassign or delete them first`,
        referenced_resource_ids: refs.map((r) => r.id),
      },
      409,
    );
  }

  const { error } = await db
    .from('secret_managers')
    .delete()
    .eq('organization_id', org.id)
    .eq('id', smId);

  if (error) {
    if (error.code === '42501') return errorResponse('forbidden', 403);
    if (error.code === '23503')
      return errorResponse('referenced', 409, 'secret_manager is still referenced by a resource');
    return errorResponse('database_error', 500, error.message);
  }

  // Probe to detect RLS-silent denial.
  const { data: stillThere } = (await db
    .from('secret_managers')
    .select('id')
    .eq('organization_id', org.id)
    .eq('id', smId)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };
  if (stillThere) return errorResponse('forbidden', 403);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'secret_manager.deleted',
    scope: { secret_manager_id: existing.id, kind: existing.kind, name: existing.name },
    subject: { name: existing.name, kind: existing.kind },
  });

  return jsonResponse({ ok: true }, 200);
}
