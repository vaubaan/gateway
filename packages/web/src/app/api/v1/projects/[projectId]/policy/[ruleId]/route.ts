/**
 * Delete a single policy_rules row — user-session authenticated.
 *
 *   DELETE /api/v1/projects/:projectId/policy/:ruleId?orgSlug=…
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; ruleId: string }> },
) {
  const { projectId, ruleId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;
  const svc = getSupabaseServiceClient();
  const { data: project } = await svc
    .from('projects')
    .select('id, organization_id')
    .eq('id', projectId)
    .maybeSingle<{ id: string; organization_id: string }>();
  if (!project || project.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }
  const { error } = await svc
    .from('policy_rules')
    .delete()
    .eq('id', ruleId)
    .eq('project_id', projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true }, { status: 200 });
}
