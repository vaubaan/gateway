/**
 * Roles discovery for the Coding Agent Runner.
 *
 *   GET /api/v1/runner/roles
 *     Authorization: Bearer vbn_mgmt_…
 *
 *   returns 200 { roles: [{ id, name, provider, description, is_builtin }] }
 *
 * Lists every Role the bound org can attach to a runner-minted AccessToken :
 *   - global builtins (`organization_id IS NULL`, `is_builtin = true`)
 *   - custom roles scoped to the bound org (`organization_id = $orgId`)
 *
 * The Runner uses the returned `id` field as `roleIds[]` on the subsequent
 * POST /api/v1/runner/tokens.
 *
 * Spec : docs/spec/mcp-proxy.md §8.8.
 * ADR  : docs/decisions/org-management-keys-for-runner.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import type { Provider } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RoleRow {
  id: string;
  name: string;
  provider: Provider;
  description: string | null;
  is_builtin: boolean;
  organization_id: string | null;
}

export async function GET(req: NextRequest) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data, error } = await svc
    .from('roles')
    .select('id, name, provider, description, is_builtin, organization_id')
    .or(`organization_id.is.null,organization_id.eq.${guard.orgId}`)
    .order('name')
    .returns<RoleRow[]>();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Hide the org_id field from the wire — it's not actionable for the Runner.
  const roles = (data ?? []).map(({ organization_id: _orgId, ...rest }) => rest);
  return NextResponse.json({ roles });
}
