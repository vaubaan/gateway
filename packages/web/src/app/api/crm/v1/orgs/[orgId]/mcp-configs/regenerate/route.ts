/**
 * `/api/crm/v1/orgs/:orgId/mcp-configs/regenerate` — POST.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.6.
 *
 * Resolves the Resources visible at the requested scope, composes the
 * MCP snapshot via `composeMcpConfig`, and UPSERTs the result under
 * `(organization_id, project_id, variant)` (unique index from
 * migration 1000 with NULLS NOT DISTINCT).
 *
 * Idempotency: if the freshly-computed snapshot is byte-equivalent to
 * the existing row, we **do not** touch the DB — `generated_at` stays
 * unchanged, the response carries `{ regenerated: false }`, and no
 * audit entry is written.
 *
 * Audit: on a real regenerate, we log `mcp_config.regenerated` with
 * the snapshot hash + scope info. The snapshot itself never lands in
 * the log row.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';
import { composeMcpConfig, type ComposableKind, type ComposableResource } from '@crm/core/mcp';

import { findOrgIdBySlugOrId, getDb } from '@/lib/resources/db';
import { resolveScopedResources, type ScopedResourceRow } from '@/lib/mcp/resolve-scope';
import { snapshotHash, snapshotsByteEqual } from '@/lib/mcp/snapshot-hash';
import { parseRegenerateBody, type ValidationError } from '@/lib/validation/mcp-configs';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly orgId: string }>;
}

interface McpConfigRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly variant: string | null;
  readonly mcp_snapshot: Record<string, unknown>;
  readonly env_snapshot: Record<string, unknown>;
  readonly generated_at: string;
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
  const parsed = parseRegenerateBody(raw);
  if (!parsed.ok) return validationErrorResponse(parsed.error);
  const input = parsed.value;

  // 1) Resolve the in-scope Resources.
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

  // 2) Compose the MCP snapshot.
  const composed = composeMcpConfig({
    resources: toComposableResources(resources),
    env: composeEnv,
  });
  const newMcp = composed.mcpJson as unknown as Record<string, unknown>;
  const newEnv = composed.envManifest as unknown as Record<string, unknown>;

  // 3) Look up the existing row, if any. Two branches because the
  // PostgREST chain uses `.is(col, null)` for NULL match and `.eq` for
  // a UUID match — both code paths surface a `maybeSingle()` result.
  let existingRow: McpConfigRow | null = null;
  if (input.scopeId === null) {
    // PostgREST: `project_id is null` AND `variant is null|eq.v`.
    const chain = db
      .from('mcp_configs')
      .select('id, organization_id, project_id, variant, mcp_snapshot, env_snapshot, generated_at')
      .eq('organization_id', org.id) as unknown as {
      eq(col: string, val: string): unknown;
      is(col: string, val: null): unknown;
      maybeSingle(): Promise<{ data: McpConfigRow | null; error: unknown }>;
    };
    let q = (chain as { is(col: string, val: null): unknown }).is('project_id', null) as {
      eq(col: string, val: string): unknown;
      is(col: string, val: null): unknown;
      maybeSingle(): Promise<{ data: McpConfigRow | null; error: unknown }>;
    };
    if (input.variant !== null) {
      q = (q as { eq(col: string, val: string): unknown }).eq('variant', input.variant) as typeof q;
    } else {
      q = (q as { is(col: string, val: null): unknown }).is('variant', null) as typeof q;
    }
    const { data } = await q.maybeSingle();
    existingRow = data;
  } else {
    // scope=project, scopeId is a UUID.
    const chain = db
      .from('mcp_configs')
      .select('id, organization_id, project_id, variant, mcp_snapshot, env_snapshot, generated_at')
      .eq('organization_id', org.id)
      .eq('project_id', input.scopeId) as unknown as {
      eq(col: string, val: string): unknown;
      is(col: string, val: null): unknown;
      maybeSingle(): Promise<{ data: McpConfigRow | null; error: unknown }>;
    };
    let q = chain;
    if (input.variant !== null) {
      q = (q as { eq(col: string, val: string): unknown }).eq('variant', input.variant) as typeof q;
    } else {
      q = (q as { is(col: string, val: null): unknown }).is('variant', null) as typeof q;
    }
    const { data } = await q.maybeSingle();
    existingRow = data;
  }

  // 4) Idempotency: byte-equal → no-op.
  if (
    existingRow !== null &&
    snapshotsByteEqual(
      { mcp_snapshot: existingRow.mcp_snapshot, env_snapshot: existingRow.env_snapshot },
      { mcp_snapshot: newMcp, env_snapshot: newEnv },
    )
  ) {
    return jsonResponse(
      {
        regenerated: false,
        mcp_config: existingRow,
        hash: snapshotHash({ mcp_snapshot: newMcp, env_snapshot: newEnv }),
      },
      200,
    );
  }

  // 5) UPSERT on the unique index (org, project_id, variant).
  const upsertRow = {
    organization_id: org.id,
    project_id: input.scopeId,
    variant: input.variant,
    mcp_snapshot: newMcp,
    env_snapshot: newEnv,
    generated_at: new Date().toISOString(),
  };

  const upsertChain = (
    db.from('mcp_configs') as unknown as {
      upsert(
        row: Record<string, unknown>,
        opts?: { onConflict?: string },
      ): {
        select(cols: string): {
          single(): Promise<{
            data: McpConfigRow | null;
            error: { code?: string; message: string } | null;
          }>;
        };
      };
    }
  ).upsert(upsertRow, { onConflict: 'organization_id,project_id,variant' });

  const { data: inserted, error } = await upsertChain
    .select('id, organization_id, project_id, variant, mcp_snapshot, env_snapshot, generated_at')
    .single();

  if (error) {
    if (error.code === '42501') return errorResponse('forbidden', 403);
    return errorResponse('database_error', 500, error.message);
  }
  if (!inserted) return errorResponse('forbidden', 403);

  const hash = snapshotHash({ mcp_snapshot: newMcp, env_snapshot: newEnv });

  await db.from('audit_log').insert({
    organization_id: org.id,
    actor_user_id: userData.user.id,
    action: 'mcp_config.regenerated',
    scope: {
      mcp_config_id: inserted.id,
      project_id: inserted.project_id,
      variant: inserted.variant,
    },
    subject: {
      hash,
      resource_count: resources.length,
      mcp_servers_count: Object.keys(newMcp.mcpServers ?? {}).length,
    },
  });

  return jsonResponse({ regenerated: true, mcp_config: inserted, hash }, 200);
}
