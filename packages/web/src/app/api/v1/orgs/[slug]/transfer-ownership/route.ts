/**
 * POST /api/v1/orgs/:slug/transfer-ownership  body: { newOwnerId }
 *
 * Transfers ownership of the org to another member. Only the current owner
 * may call this. The new owner must already be a member of the org.
 *
 * After transfer, the old owner remains a regular member (can be removed
 * by anyone, including themselves).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgOwner } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  newOwnerId: z.string().uuid(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgOwner(slug);
  if (!guard.ok) return guard.response;

  if (body.newOwnerId === guard.ownerId) {
    return NextResponse.json({ error: 'user is already the owner' }, { status: 400 });
  }

  const svc = getSupabaseServiceClient();

  const { data: target } = await svc
    .from('org_members')
    .select('user_id')
    .eq('organization_id', guard.orgId)
    .eq('user_id', body.newOwnerId)
    .maybeSingle<{ user_id: string }>();
  if (!target) {
    return NextResponse.json({ error: 'target user is not a member of this org' }, { status: 404 });
  }

  const { error } = await svc
    .from('organizations')
    .update({ owner_id: body.newOwnerId })
    .eq('id', guard.orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, owner_id: body.newOwnerId });
}
