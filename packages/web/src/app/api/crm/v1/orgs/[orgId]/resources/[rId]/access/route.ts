/**
 * `GET /api/crm/v1/orgs/:orgId/resources/:rId/access` — list access keys
 * known on a Resource. Spec §6.4 (`list clés, pas valeurs`).
 *
 * The response carries only `{ key, description, rotated_at,
 * recipient_count }` — the `sealed_blob` itself is NEVER returned by
 * this list endpoint. The blob lives behind the per-key GET
 * (`/:key/route.ts`), which an org member is allowed to fetch but can
 * only decrypt for the recipients they are part of (spec §3.3 / §4.4).
 *
 * RLS-gated through `resource_access_select_member`. No service-role.
 */

import { type NextRequest, NextResponse } from 'next/server';

import {
  byteaToSealedBlob,
  findOrgIdBySlugOrId,
  findResourceByOrgAndId,
  getDb,
  type AccessRow,
} from '@/lib/resource-access/db';

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

interface AccessSummary {
  readonly key: string;
  readonly description: string | null;
  readonly rotated_at: string;
  readonly recipient_count: number;
}

function countRecipients(blob: unknown): number {
  if (
    typeof blob === 'object' &&
    blob !== null &&
    Array.isArray((blob as { recipients?: unknown }).recipients)
  ) {
    return (blob as { recipients: unknown[] }).recipients.length;
  }
  return 0;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const resource = await findResourceByOrgAndId(db, org.id, rId);
  if (!resource) return errorResponse('not_found', 404);

  const { data, error } = (await db
    .from('resource_access')
    .select('id, resource_id, key, sealed_blob, description, rotated_at')
    .eq('resource_id', rId)
    .order('key', { ascending: true })) as {
    data: ReadonlyArray<AccessRow> | null;
    error: { code?: string; message: string } | null;
  };

  if (error) return errorResponse('database_error', 500);

  const summary: AccessSummary[] = (data ?? []).map((row) => {
    const blob = byteaToSealedBlob(row.sealed_blob);
    return {
      key: row.key,
      description: row.description,
      rotated_at: row.rotated_at,
      recipient_count: countRecipients(blob),
    };
  });

  return jsonResponse({ access: summary }, 200);
}
