/**
 * Org Management Key — revoke / delete.
 *
 *   DELETE /api/v1/orgs/:slug/management-keys/:keyId
 *
 * Hard delete (a management key only authenticates /api/v1/mgmt/* calls —
 * we don't keep tombstones for it like we do for AccessTokens, which are
 * referenced by audit_log rows).
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §8.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; keyId: string }> },
) {
  const { slug, keyId } = await ctx.params;
  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: key } = await svc
    .from('org_management_keys')
    .select('id, organization_id')
    .eq('id', keyId)
    .maybeSingle<{ id: string; organization_id: string }>();
  if (!key || key.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'management key not found in this org' }, { status: 404 });
  }

  const { error } = await svc.from('org_management_keys').delete().eq('id', keyId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
