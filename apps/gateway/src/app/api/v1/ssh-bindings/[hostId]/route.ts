/**
 * DELETE /api/v1/ssh-bindings/:hostId?orgSlug= — delete a standalone SSH binding.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ hostId: string }> }) {
  const { hostId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug required' }, { status: 400 });

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();

  const { data: row } = await svc
    .from('ssh_bindings')
    .select('id, project_id, projects!inner(organization_id)')
    .eq('id', hostId)
    .is('bash_binding_id', null)
    .maybeSingle<{ id: string; project_id: string; projects: { organization_id: string } }>();

  if (!row || row.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'SSH binding not found in this org' }, { status: 404 });
  }

  const { error } = await svc.from('ssh_bindings').delete().eq('id', hostId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
