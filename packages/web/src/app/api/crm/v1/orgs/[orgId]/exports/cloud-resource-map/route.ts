/**
 * `POST /api/crm/v1/orgs/:orgId/exports/cloud-resource-map` — emit the
 * `cloud-resource-map.json` consumed by the Coding Agent Runner.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.7.1.
 *
 * Always scoped to the whole org (no variant/project filter at the
 * map level — the CAR splits by variant on its side). The body is
 * **JSON metadata only** : NO sealed_blobs, NO ct, just references
 * to `(secret_manager.kind, .name)` per Access key, plus the per-key
 * `usage` (`session-injectable` / `browser-only`).
 *
 * The `usage` projection consults the recipient list of each
 * `resource_access` row — that's plain JSON (recipients are public,
 * spec §4.4) and does NOT require unsealing.
 *
 * Audit `cloud_resource_map.exported` — counts only.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';

import { findOrgIdBySlugOrId, getDb } from '@/lib/resources/db';
import { resolveScopedResources, type ScopedResourceRow } from '@/lib/mcp/resolve-scope';
import {
  pickSecretManagersForResources,
  resolveAccessBlobsForResources,
} from '@/lib/exports/resolve';
import { serializeCloudResourceMap } from '@/lib/exports/serialize';

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

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  void req;
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  let resources: ReadonlyArray<ScopedResourceRow>;
  try {
    resources = await resolveScopedResources({
      db,
      organizationId: org.id,
      scope: 'org',
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

  let secretManagers;
  try {
    secretManagers = await pickSecretManagersForResources(db, resources);
  } catch (e) {
    return errorResponse(
      'database_error',
      500,
      e instanceof Error ? e.message : 'failed to resolve secret managers',
    );
  }

  // No Runner pubkey registered in v1 (Phase 7) — every `usage` falls
  // back to `browser-only`. Phase 8 will plug the org's Runner
  // fingerprint here (spec §4.2).
  const runnerFingerprint: string | null = null;

  const body = serializeCloudResourceMap({
    organization_id: org.id,
    exported_at: new Date().toISOString(),
    resources,
    accesses,
    secretManagers,
    runnerFingerprint,
    kindLookup(kindId) {
      const k = findKind(kindId);
      if (!k) return undefined;
      return {
        mcpFragment: k.mcpFragment?.bind(k),
        egressHosts: k.egressHosts.bind(k),
      };
    },
  });

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'cloud_resource_map.exported',
    scope: { organization_id: org.id },
    subject: {
      resource_count: body.resources.length,
      access_key_count: body.resources.reduce((n, r) => n + r.access_keys.length, 0),
    },
  });

  return jsonResponse(body, 200);
}
