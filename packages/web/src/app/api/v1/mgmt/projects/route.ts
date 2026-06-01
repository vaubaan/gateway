/**
 * Projects + bindings discovery for ManagementKey-authenticated callers.
 *
 *   GET /api/v1/mgmt/projects
 *     Authorization: Bearer vbn_mgmt_…
 *
 *   returns 200 {
 *     projects: [
 *       {
 *         id, slug, name, created_at,
 *         bindings: [{ provider, resource_ref, display_name }]
 *       }
 *     ]
 *   }
 *
 * Lists every project of the org bound to the management key, along with
 * its provider bindings. The caller uses `slug` as `projectSlug` on the
 * subsequent POST /api/v1/mgmt/tokens.
 *
 * Spec : docs/spec/vaubaan-gateway.md §8.8.
 * ADR  : docs/decisions/programmatic-access-token-minting.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import type { Provider } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

interface BindingRow {
  project_id: string;
  provider: Provider;
  resource_ref: string;
  display_name: string | null;
}

export async function GET(req: NextRequest) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();

  const { data: projects, error: pErr } = await svc
    .from('projects')
    .select('id, slug, name, created_at')
    .eq('organization_id', guard.orgId)
    .order('created_at', { ascending: false })
    .returns<ProjectRow[]>();
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

  const projectIds = (projects ?? []).map((p) => p.id);
  let bindingsByProject = new Map<string, BindingRow[]>();
  if (projectIds.length > 0) {
    const { data: bindings, error: bErr } = await svc
      .from('provider_bindings')
      .select('project_id, provider, resource_ref, display_name')
      .in('project_id', projectIds)
      .returns<BindingRow[]>();
    if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 });
    bindingsByProject = (bindings ?? []).reduce((acc, b) => {
      const list = acc.get(b.project_id) ?? [];
      list.push(b);
      acc.set(b.project_id, list);
      return acc;
    }, new Map<string, BindingRow[]>());
  }

  const out = (projects ?? []).map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    created_at: p.created_at,
    bindings: (bindingsByProject.get(p.id) ?? []).map(({ project_id: _pid, ...rest }) => rest),
  }));

  return NextResponse.json({ projects: out });
}
