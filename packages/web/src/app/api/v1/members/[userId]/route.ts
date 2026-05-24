/**
 * PATCH  /api/v1/members/:userId  body: { orgSlug, role }
 * DELETE /api/v1/members/:userId?orgSlug=...
 *
 * Prevent self-removal of the last admin (would lock the org).
 *
 * Spec : docs/spec/mcp-proxy.md §8.1.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgAdmin } from '@/lib/auth/require-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  orgSlug: z.string().min(1),
  role: z.enum(['member', 'admin']),
});

async function ensureNotLastAdmin(
  svc: ReturnType<typeof getSupabaseServiceClient>,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const { count } = await svc
    .from('org_members')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('role', 'admin');
  if ((count ?? 0) > 1) return null;
  // Only one admin — if the action targets that admin, refuse.
  const { data: me } = await svc
    .from('org_members')
    .select('role')
    .eq('organization_id', orgId)
    .eq('user_id', userId)
    .maybeSingle<{ role: string }>();
  if (me?.role === 'admin') {
    return 'cannot demote or remove the last admin of this org';
  }
  return null;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const { userId } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }
  const guard = await requireOrgAdmin(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  if (body.role === 'member') {
    const lock = await ensureNotLastAdmin(svc, guard.orgId, userId);
    if (lock) return NextResponse.json({ error: lock }, { status: 409 });
  }
  const { error } = await svc
    .from('org_members')
    .update({ role: body.role })
    .eq('organization_id', guard.orgId)
    .eq('user_id', userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const { userId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  const guard = await requireOrgAdmin(orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const lock = await ensureNotLastAdmin(svc, guard.orgId, userId);
  if (lock) return NextResponse.json({ error: lock }, { status: 409 });

  const { error } = await svc
    .from('org_members')
    .delete()
    .eq('organization_id', guard.orgId)
    .eq('user_id', userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
