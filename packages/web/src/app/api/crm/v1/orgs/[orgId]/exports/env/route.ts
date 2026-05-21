/**
 * `POST /api/crm/v1/orgs/:orgId/exports/env` — export the sealed
 * envelope of every Access visible at the requested scope.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.7, §7.5.
 *
 * Returns `{ entries: [{ key, sealed_blob, source_resource_id, ... }] }`.
 * The browser:
 *
 *   1. Iterates entries.
 *   2. For each, tries `unsealAs(blob, fingerprint, identity)` with
 *      the local user's keypair.
 *   3. Concats `${key}=${cleartext}` lines into a `.env`, or pairs
 *      into JSON when `format='json'`. Lines where unseal fails
 *      (user is not a recipient) become `# UNAVAILABLE: <key>` so the
 *      output still documents the missing slot.
 *
 * ZK invariant: this endpoint **never** unseals — it only ships the
 * sealed_blobs. Audit `resource.access.exported` carries the count of
 * exported entries; **no** ct ever lands in the log.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, getDb } from '@/lib/resources/db';
import { resolveScopedResources, type ScopedResourceRow } from '@/lib/mcp/resolve-scope';
import { resolveAccessBlobsForResources } from '@/lib/exports/resolve';
import { serializeExportEnv } from '@/lib/exports/serialize';
import { parseExportEnvBody, type ValidationError } from '@/lib/validation/exports';

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

function validationErrorResponse(err: ValidationError): NextResponse {
  return errorResponse(err.code, 400, err.message);
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseExportEnvBody(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  let resources: ReadonlyArray<ScopedResourceRow>;
  try {
    resources = await resolveScopedResources({
      db,
      organizationId: org.id,
      scope: input.scope,
      projectId: input.scopeId,
      variant: input.variant,
    });
  } catch (e) {
    return errorResponse(
      'database_error',
      500,
      e instanceof Error ? e.message : 'failed to resolve scope',
    );
  }

  const ids = resources.map((r) => r.id);
  let accesses;
  try {
    accesses = await resolveAccessBlobsForResources(db, ids);
  } catch (e) {
    return errorResponse(
      'database_error',
      500,
      e instanceof Error ? e.message : 'failed to resolve access',
    );
  }

  const body = serializeExportEnv(input.format, resources, accesses);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.access.exported',
    scope: {
      export_scope: input.scope,
      project_id: input.scopeId,
      variant: input.variant,
      format: input.format,
    },
    subject: {
      resource_count: resources.length,
      entry_count: body.entries.length,
    },
  });

  return jsonResponse(body, 200);
}
