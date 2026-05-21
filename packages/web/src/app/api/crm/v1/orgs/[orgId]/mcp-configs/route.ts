/**
 * `/api/crm/v1/orgs/:orgId/mcp-configs` — list MCP snapshots.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.6.
 *
 * Returns the live `mcp_configs` rows for the org, optionally filtered
 * by `project_id` and `variant`. RLS gates row visibility (members
 * only). No mutation here — the regenerate endpoint lives at
 * `./regenerate/route.ts`.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { findOrgIdBySlugOrId, getDb } from '@/lib/resources/db';
import { parseListMcpConfigFilters, type ValidationError } from '@/lib/validation/mcp-configs';

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

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { orgId: orgSegment } = await ctx.params;
  const db = await getDb();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return errorResponse('unauthorized', 401);

  const org = await findOrgIdBySlugOrId(db, orgSegment);
  if (!org) return errorResponse('not_found', 404);

  const url = new URL(req.url);
  const filters = parseListMcpConfigFilters(url.searchParams);
  if (!filters.ok) return validationErrorResponse(filters.error);

  let query = db
    .from('mcp_configs')
    .select('id, organization_id, project_id, variant, mcp_snapshot, env_snapshot, generated_at')
    .eq('organization_id', org.id);

  if (filters.value.projectId) query = query.eq('project_id', filters.value.projectId);
  if (filters.value.variant) query = query.eq('variant', filters.value.variant);

  const { data, error } = (await query.order('generated_at', { ascending: false })) as {
    data: ReadonlyArray<McpConfigRow> | null;
    error: { code?: string; message: string } | null;
  };

  if (error) return errorResponse('database_error', 500);
  return jsonResponse({ mcp_configs: data ?? [] }, 200);
}
