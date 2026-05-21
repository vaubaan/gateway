/**
 * `/api/crm/v1/orgs/:orgId/resources/:rId/access/:key` — sealed blob CRUD.
 *
 * Spec §6.4 :
 *
 *     GET    /access/:key        -- return the sealed_blob
 *     PUT    /access/:key        -- upsert sealed_blob (admin only)
 *     DELETE /access/:key        -- delete the row (admin only)
 *
 * The blob shape is enforced by `parseSealedBlob` — `v=1`, ≥ 1
 * recipient, every `fp` is 32 lowercase hex, every `ct` decodes to a
 * ≥ 48-byte sealed-box envelope. The audit_log writes **only**
 * `{ resource_id, key, recipient_count }` — never the `ct` itself
 * (ZK invariant, spec §2.3).
 */

import { type NextRequest, NextResponse } from 'next/server';

import {
  byteaToSealedBlob,
  findOrgIdBySlugOrId,
  findResourceByOrgAndId,
  getDb,
  sealedBlobToBytea,
  type AccessRow,
} from '@/lib/resource-access/db';
import {
  isValidAccessKey,
  parseSealedBlob,
  type ValidationError,
} from '@/lib/validation/sealed-blob';

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

function validationErrorResponse(err: ValidationError): NextResponse {
  return errorResponse(err.code, 400, err.message);
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId, key } = await ctx.params;
  if (!isValidAccessKey(key)) return errorResponse('invalid_field', 400, 'invalid access key');

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
    .eq('key', key)
    .maybeSingle()) as {
    data: AccessRow | null;
    error: { code?: string; message: string } | null;
  };

  if (error) return errorResponse('database_error', 500);
  if (!data) return errorResponse('not_found', 404);

  const blob = byteaToSealedBlob(data.sealed_blob);
  if (blob === null) return errorResponse('database_error', 500, 'corrupted sealed_blob');

  return jsonResponse(
    {
      key: data.key,
      description: data.description,
      rotated_at: data.rotated_at,
      sealed_blob: blob,
    },
    200,
  );
}

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId, key } = await ctx.params;
  if (!isValidAccessKey(key)) return errorResponse('invalid_field', 400, 'invalid access key');

  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const resource = await findResourceByOrgAndId(db, org.id, rId);
  if (!resource) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseSealedBlob(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const blob = parsed.value;

  // Optional `description` field at the envelope level.
  let description: string | null = null;
  try {
    const envelope = JSON.parse(raw) as unknown;
    if (
      typeof envelope === 'object' &&
      envelope !== null &&
      typeof (envelope as { description?: unknown }).description === 'string'
    ) {
      description = (envelope as { description: string }).description;
    }
  } catch {
    // unreachable — parseSealedBlob already validated the JSON.
  }

  // Upsert on (resource_id, key) — unique constraint in migration 1000.
  const upsertRow = {
    resource_id: rId,
    key,
    sealed_blob: sealedBlobToBytea(blob),
    description,
    rotated_at: new Date().toISOString(),
  };

  const { data, error } = (await db
    .from('resource_access')
    .upsert(upsertRow, { onConflict: 'resource_id,key' })
    .select('id, resource_id, key, description, rotated_at')
    .single()) as {
    data: { id: string } | null;
    error: { code?: string; message: string } | null;
  };

  if (error) {
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }
  if (!data) return errorResponse('forbidden', 403);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.access.put',
    scope: { resource_id: rId, kind: resource.kind, scope: resource.scope, key },
    subject: { recipient_count: blob.recipients.length },
  });

  return jsonResponse({ ok: true, key, recipient_count: blob.recipients.length }, 200);
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment, rId, key } = await ctx.params;
  if (!isValidAccessKey(key)) return errorResponse('invalid_field', 400, 'invalid access key');

  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const resource = await findResourceByOrgAndId(db, org.id, rId);
  if (!resource) return errorResponse('not_found', 404);

  // Snapshot for audit + 404/403 disambiguation.
  const { data: existing } = (await db
    .from('resource_access')
    .select('id, resource_id, key, sealed_blob')
    .eq('resource_id', rId)
    .eq('key', key)
    .maybeSingle()) as { data: AccessRow | null; error: unknown };
  if (!existing) return errorResponse('not_found', 404);

  const recipientCount = (() => {
    const blob = byteaToSealedBlob(existing.sealed_blob);
    if (
      typeof blob === 'object' &&
      blob !== null &&
      Array.isArray((blob as { recipients?: unknown }).recipients)
    ) {
      return (blob as { recipients: unknown[] }).recipients.length;
    }
    return 0;
  })();

  const { error } = await db.from('resource_access').delete().eq('resource_id', rId).eq('key', key);

  if (error) {
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500);
  }

  // Probe for RLS-silent denial.
  const { data: stillThere } = (await db
    .from('resource_access')
    .select('id')
    .eq('resource_id', rId)
    .eq('key', key)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };
  if (stillThere) return errorResponse('forbidden', 403);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.access.deleted',
    scope: { resource_id: rId, kind: resource.kind, scope: resource.scope, key },
    subject: { recipient_count: recipientCount },
  });

  return jsonResponse({ ok: true }, 200);
}
