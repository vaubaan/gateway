/**
 * Org-scoped root token — revoke / delete.
 *
 *   DELETE /api/v1/orgs/:slug/management-keys/:keyId
 *
 * Hard-deletes the token row from the unified `tokens` table. Children
 * tokens (parent_id = keyId) cascade-delete via the FK.
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
    .from('tokens')
    .select('id, organization_id, scope, parent_id')
    .eq('id', keyId)
    .maybeSingle<{
      id: string;
      organization_id: string;
      scope: string;
      parent_id: string | null;
    }>();
  if (
    !key ||
    key.organization_id !== guard.orgId ||
    key.scope !== 'org' ||
    key.parent_id !== null
  ) {
    return NextResponse.json({ error: 'management key not found in this org' }, { status: 404 });
  }

  const { error } = await svc.from('tokens').delete().eq('id', keyId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
