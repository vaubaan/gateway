/**
 * DELETE /api/v1/members/:userId?orgSlug=...
 *
 * Removes a member from the org. The owner cannot be removed — they must
 * first transfer ownership via POST /api/v1/orgs/:slug/transfer-ownership.
 *
 * Spec : docs/spec/mcp-proxy.md §8.1.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const { userId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  if (userId === guard.ownerId) {
    return NextResponse.json(
      { error: 'cannot remove the org owner — transfer ownership first' },
      { status: 409 },
    );
  }

  const svc = getSupabaseServiceClient();
  const { error } = await svc
    .from('org_members')
    .delete()
    .eq('organization_id', guard.orgId)
    .eq('user_id', userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
