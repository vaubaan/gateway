/**
 * POST /api/v1/members  body: { orgSlug, email }
 *
 * Adds a user to an Org. If the user doesn't exist in auth.users, we invite
 * them (Supabase Admin createUser + generateLink type='invite').
 *
 * Membership is flat — any org member has full RW. The org's `owner_id` is
 * separate (set at org creation, transferable via /transfer-ownership).
 *
 * Spec : docs/spec/vaubaan-gateway.md §8.1, §10.
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
  email?: string;
}

/**
 * Walk all listUsers() pages (case-insensitive). Falls back to the Auth admin
 * REST endpoint with filter= to catch unconfirmed invites and other user states
 * that listUsers() may omit in some Supabase configurations.
 */
async function lookupUserByEmail(
  svc: ReturnType<typeof getSupabaseServiceClient>,
  email: string,
): Promise<string | undefined> {
  const normalized = email.toLowerCase();
  const perPage = 1000;
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users.length) break;
    const found = (data.users as AdminUser[]).find((u) => u.email?.toLowerCase() === normalized);
    if (found) return found.id;
    hasMore = data.users.length >= perPage;
    page++;
  }

  // Fallback: the Auth admin REST endpoint supports ?filter=<email> and returns
  // users in all states including unconfirmed invites (email_confirmed_at = NULL).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) return undefined;
  try {
    const resp = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&page=1&per_page=10`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!resp.ok) return undefined;
    const raw = (await resp.json()) as { users?: AdminUser[] };
    return raw.users?.find((u) => u.email?.toLowerCase() === normalized)?.id;
  } catch {
    return undefined;
  }
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

  // Find user by email (paged listUsers + REST filter fallback).
  let userId = await lookupUserByEmail(svc, body.email);
  let invited = false;

  if (!userId) {
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email: body.email,
      email_confirm: false,
    });

    if (createErr) {
      // "already registered" means the user exists but neither listUsers() nor the
      // REST filter found them (unconfirmed invite in an unusual state, SSO-only, etc.).
      if (createErr.message?.toLowerCase().includes('already')) {
        return NextResponse.json(
          {
            error:
              'This email is already registered. ' +
              'Ask the user to check their inbox for a pending invite, then retry.',
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: createErr.message ?? 'failed to invite user' },
        { status: 500 },
      );
    }
    userId = created.user.id;
    invited = true;
    await svc.auth.admin.generateLink({ type: 'invite', email: body.email }).catch(() => null);
  }

  // Reject if user is already a member of THIS org (the true duplicate case).
  const { data: existing } = await svc
    .from('org_members')
    .select('user_id')
    .eq('organization_id', guard.orgId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: 'User is already a member of this organization.' },
      { status: 409 },
    );
  }

  const { error: memErr } = await svc
    .from('org_members')
    .insert({ organization_id: guard.orgId, user_id: userId });
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

  return NextResponse.json({ user_id: userId, invited });
}
