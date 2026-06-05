/**
 * DELETE /api/v1/vps-ssh-bindings/:bindingId?orgSlug=
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) {
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  }

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: binding } = await svc
    .from('vps_ssh_bindings')
    .select('id, project_id, projects!inner(organization_id)')
    .eq('id', bindingId)
    .maybeSingle<{ id: string; project_id: string; projects: { organization_id: string } }>();

  if (!binding || binding.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'binding not found in this org' }, { status: 404 });
  }

  const { error } = await svc.from('vps_ssh_bindings').delete().eq('id', bindingId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
