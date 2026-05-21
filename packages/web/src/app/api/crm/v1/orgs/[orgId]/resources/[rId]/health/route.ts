/**
 * `POST /api/crm/v1/orgs/:orgId/resources/:rId/health` — health probe stub.
 *
 * Spec §6.3 calls for a Runner-side execution of `kind.healthTestCmd`.
 * Phase 4 ships an audit-only stub: the request is recorded as
 * `resource.health.requested` (so the timeline shows the click in the
 * UI), and the response is a 202 with `pending-runner`. The actual
 * dispatch arrives in Phase 6 with the Runner integration.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, getDb, type ResourceRow } from '@/lib/resources/db';

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

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const { data: resource } = (await db
    .from('resources')
    .select('id, kind, scope')
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle()) as {
    data: Pick<ResourceRow, 'id' | 'kind' | 'scope'> | null;
    error: unknown;
  };
  if (!resource) return errorResponse('not_found', 404);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.health.requested',
    scope: { resource_id: resource.id, kind: resource.kind, scope: resource.scope },
    subject: {},
  });

  return jsonResponse(
    { status: 'pending-runner', message: 'health checks dispatch to Runner in Phase 6' },
    202,
  );
}
