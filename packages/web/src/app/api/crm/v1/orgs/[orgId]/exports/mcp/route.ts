/**
 * `POST /api/crm/v1/orgs/:orgId/exports/mcp` — export the `mcp.json`
 * snapshot + its `.env` companion (placeholders + sealed_blobs).
 *
 * Spec docs/spec/cloud-resource-manager.md §6.7.
 *
 * The response carries:
 *
 *   - `mcp_json` — the composed `{ mcpServers: ... }`.
 *   - `env_manifest` — manifest of `${KEY}` placeholders referenced by
 *     the snapshot.
 *   - `env_dotenv_template` — pre-rendered `.env-mcp` skeleton, still
 *     with `${KEY}` placeholders (browser substitutes after unseal).
 *   - `env_entries` — for each manifest key, the sealed_blob if it
 *     exists (so the browser can resolve placeholders client-side).
 *
 * Audit `resource.access.exported` — same shape as `/exports/env`.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';
import { composeMcpConfig, type ComposableKind, type ComposableResource } from '@crm/core/mcp';

import { findOrgIdBySlugOrId, getDb } from '@/lib/resources/db';
import { resolveScopedResources, type ScopedResourceRow } from '@/lib/mcp/resolve-scope';
import { resolveAccessBlobsForResources } from '@/lib/exports/resolve';
import { serializeExportMcp } from '@/lib/exports/serialize';
import { parseExportMcpBody, type ValidationError } from '@/lib/validation/exports';

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

function toComposableResources(rows: ReadonlyArray<ScopedResourceRow>): ComposableResource[] {
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    variant: r.variant,
    provider_metadata: r.provider_metadata,
  }));
}

const composeEnv = {
  findKind(id: string): ComposableKind | undefined {
    const k = findKind(id);
    if (!k) return undefined;
    return {
      id: k.id,
      accessSchema: k.accessSchema,
      mcpFragment: k.mcpFragment?.bind(k),
    };
  },
};

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const raw = await req.text();
  const parsed = parseExportMcpBody(raw);
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

  const composed = composeMcpConfig({
    resources: toComposableResources(resources),
    env: composeEnv,
  });

  // Fetch sealed_blobs only for the resources actually referenced by
  // the manifest, not every Resource at scope (saves bandwidth when a
  // project has many no-MCP Resources).
  const idsWithMcp = Array.from(
    new Set(composed.envManifest.keys.map((k) => k.source_resource_id)),
  );
  let accesses;
  try {
    accesses = await resolveAccessBlobsForResources(db, idsWithMcp);
  } catch (e) {
    return errorResponse(
      'database_error',
      500,
      e instanceof Error ? e.message : 'failed to resolve access',
    );
  }

  const body = serializeExportMcp(composed, resources, accesses);

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'resource.access.exported',
    scope: {
      export_scope: input.scope,
      project_id: input.scopeId,
      variant: input.variant,
      format: 'mcp',
    },
    subject: {
      resource_count: resources.length,
      mcp_servers_count: Object.keys(composed.mcpJson.mcpServers).length,
      env_entry_count: body.env_entries.length,
    },
  });

  return jsonResponse(body, 200);
}
