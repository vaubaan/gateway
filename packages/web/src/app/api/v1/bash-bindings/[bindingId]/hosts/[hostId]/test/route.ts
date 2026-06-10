/**
 * POST /api/v1/bash-bindings/:bindingId/hosts/:hostId/test?orgSlug=
 *
 * SSH connectivity smoke test for one host : runs `uptime`.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { decodeBytea } from '@/lib/providers/bytea';
import { sshExec } from '@vaubaan/providers-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HostRow {
  id: string;
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key: unknown;
  bash_binding_id: string;
  bash_bindings: { projects: { organization_id: string } };
}

export async function POST(
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
    .select(
      'id, host_address, port, ssh_user, ssh_private_key, bash_binding_id, bash_bindings!inner(projects!inner(organization_id))',
    )
    .eq('id', hostId)
    .eq('bash_binding_id', bindingId)
    .maybeSingle<HostRow>();

  if (!host || host.bash_bindings.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'host not found' }, { status: 404 });
  }

  const keyBytes = decodeBytea(host.ssh_private_key);
  if (!keyBytes) {
    return NextResponse.json({ error: 'SSH private key is missing or corrupt.' }, { status: 500 });
  }

  try {
    const result = await sshExec(
      {
        host_address: host.host_address,
        port: host.port,
        ssh_user: host.ssh_user,
        ssh_private_key_pem: new TextDecoder().decode(keyBytes),
      },
      'uptime',
      10,
    );
    return NextResponse.json({
      ok: result.exit_code === 0,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.duration_ms,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
