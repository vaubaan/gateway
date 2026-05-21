/**
 * `POST /api/crm/v1/orgs/:orgId/resources/:rId/refresh` — metadata refresh stub.
 *
 * Spec §6.3 calls for a provider-side fetch of fresh metadata. Phase 4
 * audits the request and returns 202 `pending-runner`. The actual
 * fetcher lives in Phase 6 next to the Runner adapters.
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
    action: 'resource.refresh.requested',
    scope: { resource_id: resource.id, kind: resource.kind, scope: resource.scope },
    subject: {},
  });

  return jsonResponse(
    { status: 'pending-runner', message: 'metadata refresh dispatch to Runner in Phase 6' },
    202,
  );
}
