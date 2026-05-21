/**
 * `POST /api/crm/v1/orgs/:orgId/resources/:rId/access/:key/rotate`
 *
 * Phase 4 ships an audit-only stub. The actual rotation dispatch
 * depends on `kind.rotationMethod` (spec §0.1) and lives in Phase 6:
 *
 *  - `manual`         → return a 202 with `next_step='operator-action'`
 *                       and a marker. The UI is expected to redirect
 *                       to the kind's setupDocs.
 *  - `self`           → 202 `next_step='runner-self-rotation'`,
 *                       runner picks the job up.
 *  - `admin-mediated` → 202 `next_step='admin-rotate-child'`, the
 *                       parent Admin resource dispatches.
 *
 * The response carries the `rotation_method` so the UI knows which
 * branch to take without doing its own catalog lookup. The Runner
 * dispatch lands in Phase 6.
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

  const kind = findKind(resource.kind);
  // resource.kind comes from a previously-validated POST /resources, so
  // findKind should always succeed. Fall back to 'manual' if the catalog
  // version drifted (defensive — Phase 4 doesn't ship a way to register
  // resources of unknown kind).
  const method: 'self' | 'admin-mediated' | 'manual' = kind?.rotationMethod ?? 'manual';

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.access.rotate.requested',
    scope: { resource_id: rId, kind: resource.kind, scope: resource.scope, key },
    subject: { rotation_method: method },
  });

  return jsonResponse(
    {
      status: 'pending-runner',
      rotation_method: method,
      next_step: nextStepFor(method),
      message: 'rotation dispatch lands Phase 6',
    },
    202,
  );
}
