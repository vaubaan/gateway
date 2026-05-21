/**
 * `POST /api/crm/v1/orgs/:orgId/resources/:rId/access/:key/rotate`
 *
 * Spec §6.4 + §7.4 — rotation dispatcher. Returns a 202 with the
 * payload the browser needs to take the right path:
 *
 *  - `manual`         → 202 `{ rotation_method, next_step:'operator-action', setupDocs }`.
 *                       The UI shows setupDocs and a SealedInput.
 *  - `self`           → 202 `{ rotation_method, next_step:'runner-self-rotation' }`.
 *                       The runner picks the job up (Phase 7).
 *  - `admin-mediated` → 202 `{ rotation_method, next_step:'admin-rotate-child',
 *                       admin_resource_id, admin_kind, child_provider_ref, setupDocs }`.
 *                       The UI unseal the admin's access and calls
 *                       `admin.rotateChildAccess(...)` (browser-side).
 *                       `setupDocs` is included because the call may
 *                       throw a `*RotationNotSupportedError` whose
 *                       message the UI compares against this fallback.
 *
 * The handler does NOT touch any cleartext credential. The actual
 * provider call (admin-mediated) is performed by the browser using the
 * unsealed admin token (ZK invariant, spec §4). Once the browser has
 * the new value, it seals it and PUTs via `/access/:key` — which now
 * also flips `recipients_stale=false` (Phase 6 wave B fix).
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';

import { findOrgIdBySlugOrId, findResourceByOrgAndId, getDb } from '@/lib/resource-access/db';
import { isValidAccessKey } from '@/lib/validation/sealed-blob';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{
    readonly orgId: string;
    readonly rId: string;
    readonly key: string;
  }>;
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

function nextStepFor(method: 'self' | 'admin-mediated' | 'manual'): string {
  switch (method) {
    case 'self':
      return 'runner-self-rotation';
    case 'admin-mediated':
      return 'admin-rotate-child';
    case 'manual':
    default:
      return 'operator-action';
  }
}

interface AdminResourceForRotation {
  readonly id: string;
  readonly kind: string;
}

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId, key } = await ctx.params;
  if (!isValidAccessKey(key)) return errorResponse('invalid_field', 400, 'invalid access key');

  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const resource = await findResourceByOrgAndId(db, org.id, rId);
  if (!resource) return errorResponse('not_found', 404);

  // Fetch a wider row so we have admin_resource_id and provider_ref
  // for the dispatch payload.
  const { data: fullRow } = (await db
    .from('resources')
    .select('id, kind, scope, admin_resource_id, provider_ref')
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as {
    data: {
      id: string;
      kind: string;
      scope: string;
      admin_resource_id: string | null;
      provider_ref: string | null;
    } | null;
    error: { message: string } | null;
  };

  const kind = findKind(resource.kind);
  const method: 'self' | 'admin-mediated' | 'manual' = kind?.rotationMethod ?? 'manual';
  const setupDocs: string | undefined = kind?.setupDocs;

  // For admin-mediated: resolve the admin resource id/kind so the
  // browser can pick the right SealedReveal target.
  let adminResource: AdminResourceForRotation | null = null;
  if (method === 'admin-mediated' && fullRow?.admin_resource_id) {
    const { data: adminRow } = (await db
      .from('resources')
      .select('id, kind, is_admin')
      .eq('organization_id', org.id)
      .eq('id', fullRow.admin_resource_id)
      .maybeSingle()) as {
      data: { id: string; kind: string; is_admin: boolean } | null;
      error: { message: string } | null;
    };
    if (adminRow && adminRow.is_admin) {
      adminResource = { id: adminRow.id, kind: adminRow.kind };
    }
  }

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.access.rotate.requested',
    scope: { resource_id: rId, kind: resource.kind, scope: resource.scope, key },
    subject: {
      rotation_method: method,
      admin_resource_id: adminResource?.id ?? null,
    },
  });

  const payload: Record<string, unknown> = {
    status: 'pending-dispatch',
    rotation_method: method,
    next_step: nextStepFor(method),
  };
  if (setupDocs !== undefined) payload.setup_docs = setupDocs;
  if (method === 'admin-mediated') {
    payload.admin_resource_id = adminResource?.id ?? null;
    payload.admin_kind = adminResource?.kind ?? null;
    payload.child_provider_ref = fullRow?.provider_ref ?? null;
    if (!adminResource) {
      payload.message =
        'admin-mediated rotation requires a live admin_resource_id; re-attach an admin (spec §3.3)';
    }
  }

  return jsonResponse(payload, 202);
}
