/**
 * POST /api/v1/members  body: { orgSlug, email }
 *
 * Adds a user to an Org. If the user doesn't exist in auth.users, we invite
 * them (Supabase Admin createUser + generateLink type='invite').
 *
 * Membership is flat — any org member has full RW. The org's `owner_id` is
 * separate (set at org creation, transferable via /transfer-ownership).
 *
 * Spec : docs/spec/mcp-proxy.md §8.1, §10.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  email: z.string().email(),
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

  const guard = await requireOrgMember(body.orgSlug);
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
    await svc.auth.admin.generateLink({ type: 'invite', email: body.email }).catch(() => null);
  }

  const { error: memErr } = await svc
    .from('org_members')
    .upsert(
      { organization_id: guard.orgId, user_id: userId },
      { onConflict: 'organization_id,user_id' },
    );
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

  return NextResponse.json({ user_id: userId, invited });
}
