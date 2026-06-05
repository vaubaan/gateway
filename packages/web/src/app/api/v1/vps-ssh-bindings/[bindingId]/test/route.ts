/**
 * POST /api/v1/vps-ssh-bindings/:bindingId/test?orgSlug=
 *
 * Runs `uptime` to verify the SSH connection is working.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { decodeBytea } from '@/lib/providers/bytea';
import { sshExec } from '@vaubaan/providers-vps-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  project_id: string;
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key: unknown;
  projects: { organization_id: string };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) {
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  }

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('vps_ssh_bindings')
    .select(
      'id, project_id, host_address, port, ssh_user, ssh_private_key, projects!inner(organization_id)',
    )
    .eq('id', bindingId)
    .maybeSingle<BindingRow>();

  if (!row || row.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'binding not found in this org' }, { status: 404 });
  }

  const keyBytes = decodeBytea(row.ssh_private_key);
  if (!keyBytes) {
    return NextResponse.json({ error: 'SSH private key is missing or corrupt.' }, { status: 500 });
  }

  try {
    const result = await sshExec(
      {
        host_address: row.host_address,
        port: row.port,
        ssh_user: row.ssh_user,
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
