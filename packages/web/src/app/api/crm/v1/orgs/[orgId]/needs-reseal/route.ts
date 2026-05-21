/**
 * `GET /api/crm/v1/orgs/:orgId/needs-reseal` — list access blobs that
 * need to be re-sealed for the org's current recipients (spec §4.5).
 *
 * The endpoint joins `resource_access` (flagged `recipients_stale=true`)
 * with `resources` (visible to the user via RLS `is_org_member`). The
 * response is suitable for the banner UI to count + render a "Re-seal
 * now" button.
 *
 * RLS gates the visibility. A non-member sees 0 rows (and a 404 if the
 * org slug isn't even visible). The response NEVER carries the sealed
 * blob bytes — just the metadata the UI needs to fan out the per-blob
 * re-seal flow.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, getDb, type DbResult } from '@/lib/secret-managers/db';

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

interface ResourceRow {
  readonly id: string;
  readonly name: string;
}

interface AccessStaleRow {
  readonly resource_id: string;
  readonly key: string;
  readonly recipients_stale: boolean;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  // 1. Fetch org-visible resources (RLS gated). We pull all of them up
  //    front so the second query can scope the access list by
  //    resource_id IN (...).
  const { data: resources, error: rErr } = (await db
    .from('resources')
    .select('id, name')
    .eq('organization_id', org.id)) as DbResult<ReadonlyArray<ResourceRow>>;
  if (rErr) return errorResponse('database_error', 500);
  if (!resources || resources.length === 0) {
    return jsonResponse({ count: 0, items: [] }, 200);
  }
  const idIndex = new Map(resources.map((r) => [r.id, r.name]));

  const { data: stale, error: aErr } = (await db
    .from('resource_access')
    .select('resource_id, key, recipients_stale')
    .in('resource_id', [...idIndex.keys()])
    .eq('recipients_stale', true)
    .order('key', { ascending: true })) as DbResult<ReadonlyArray<AccessStaleRow>>;
  if (aErr) return errorResponse('database_error', 500);

  const items = (stale ?? []).map((s) => ({
    resource_id: s.resource_id,
    key: s.key,
    resource_name: idIndex.get(s.resource_id) ?? null,
  }));

  return jsonResponse({ count: items.length, items }, 200);
}
