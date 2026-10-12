/**
 * DELETE /api/v1/bash-bindings/:bindingId/hosts/:hostId?orgSlug=
 *        — detach a host from a binding (deletes the ssh_bindings row).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HostRow {
  id: string;
  bash_binding_id: string;
  bash_bindings: { project_id: string; projects: { organization_id: string } };
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ bindingId: string; hostId: string }> },
) {
  const { bindingId, hostId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug required' }, { status: 400 });

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: host } = await svc
    .from('ssh_bindings')
    .select('id, bash_binding_id, bash_bindings!inner(project_id, projects!inner(organization_id))')
    .eq('id', hostId)
    .eq('bash_binding_id', bindingId)
    .maybeSingle<HostRow>();

  if (!host || host.bash_bindings.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'host not found' }, { status: 404 });
  }

  const { error } = await svc.from('ssh_bindings').delete().eq('id', hostId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
