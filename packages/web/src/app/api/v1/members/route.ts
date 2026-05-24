/**
 * POST /api/v1/members  body: { orgSlug, email, role }
 *
 * Adds a user to an Org as member or admin. If the user doesn't exist, we
 * invite them (Supabase Admin generateLink type='invite').
 *
 * Spec : docs/spec/mcp-proxy.md §8.1, §10.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgAdmin } from '@/lib/auth/require-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['member', 'admin']).default('member'),
});

interface AdminUser {
  id: string;
  email: string;
}

export async function POST(req: NextRequest) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgAdmin(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();

  // Lookup existing user by email.
  const { data: list } = await svc.auth.admin.listUsers();
  const existing = (list.users as AdminUser[] | undefined)?.find((u) => u.email === body.email);

  let userId = existing?.id;
  let invited = false;
  if (!userId) {
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email: body.email,
      email_confirm: false,
    });
    if (createErr || !created.user) {
      return NextResponse.json(
        { error: createErr?.message ?? 'failed to invite user' },
        { status: 500 },
      );
    }
    userId = created.user.id;
    invited = true;
    // Best-effort send invite email — ignore failure (the user is already in
    // auth.users and can be invited again from Supabase dashboard).
    await svc.auth.admin.generateLink({ type: 'invite', email: body.email }).catch(() => null);
  }

  const { error: memErr } = await svc
    .from('org_members')
    .upsert(
      { organization_id: guard.orgId, user_id: userId, role: body.role },
      { onConflict: 'organization_id,user_id' },
    );
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

  return NextResponse.json({ user_id: userId, invited });
}
