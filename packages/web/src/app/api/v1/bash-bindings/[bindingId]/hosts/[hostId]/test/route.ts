/**
 * POST /api/v1/bash-bindings/:bindingId/hosts/:hostId/test?orgSlug=
 *
 * SSH connectivity smoke test for one host : runs `uptime`.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { execOnHost, loadHostByIdInOrg } from '@/lib/bash/exec-host';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const host = await loadHostByIdInOrg(svc, {
    hostId,
    bindingId,
    orgId: guard.orgId,
  });
  if (!host) return NextResponse.json({ error: 'host not found' }, { status: 404 });

  try {
    const exec = await execOnHost(host, 'uptime', 10);
    if (!exec.ok) {
      return NextResponse.json(
        { error: 'SSH private key is missing or corrupt.' },
        { status: 500 },
      );
    }
    const { result } = exec;
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
