/**
 * `POST /api/crm/v1/orgs/:orgId/resources/:rId/health` — accept a
 * browser-side health probe result and persist it.
 *
 * Spec §6.3 originally described a Runner-side execution of
 * `kind.healthTestCmd`. We've collapsed that into a synchronous
 * browser probe (cf. handbook resources-and-access.md): the unsealed
 * access already lives in the user's tab, so an extra hop through a
 * Runner buys no ZK guarantee — only latency.
 *
 * Body : `{ status: 'connected' | 'failed' | 'unknown', message?: string }`.
 * The server writes `resources.connection_status`,
 * `resources.connection_message`, `resources.connection_checked_at`
 * and an `audit_log` entry. RLS-only, no service-role.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, getDb, type ResourceRow } from '@/lib/resources/db';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly orgId: string; readonly rId: string }>;
}

const ALLOWED_STATUS = ['connected', 'failed', 'unknown'] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];

interface ParsedBody {
  readonly status: AllowedStatus;
  readonly message: string | null;
}

function parseBody(raw: string): ParsedBody | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid_json' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'invalid_field' };
  const body = parsed as { status?: unknown; message?: unknown };
  if (typeof body.status !== 'string' || !ALLOWED_STATUS.includes(body.status as AllowedStatus)) {
    return { error: 'invalid_field' };
  }
  if (body.message !== undefined && typeof body.message !== 'string') {
    return { error: 'invalid_field' };
  }
  return { status: body.status as AllowedStatus, message: (body.message as string) ?? null };
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

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseBody(raw);
  if ('error' in parsed) return errorResponse(parsed.error, 400);

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

  const now = new Date().toISOString();
  const updateBuilder = db
    .from('resources')
    .update({
      connection_status: parsed.status,
      connection_message: parsed.message,
      connection_checked_at: now,
    })
    .eq('id', resource.id);
  const updateResult = (await Promise.resolve(updateBuilder)) as unknown as {
    error: { message: string } | null;
  };
  if (updateResult.error) return errorResponse('database_error', 500);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.health.checked',
    scope: { resource_id: resource.id, kind: resource.kind, scope: resource.scope },
    subject: { status: parsed.status, checked_at: now },
  });

  return jsonResponse({ status: parsed.status, message: parsed.message, checked_at: now }, 200);
}
