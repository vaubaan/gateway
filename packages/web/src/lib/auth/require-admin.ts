/**
 * Shared admin-guard for REST routes — verifies the session user is an admin
 * of the given organization. Returns the org id on success, or a 401/403/404
 * NextResponse otherwise.
 *
 * Used by every mutation under /api/v1 that touches org-scoped resources.
 */

import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export interface AdminGuardOk {
  ok: true;
  orgId: string;
  userId: string;
}

export interface AdminGuardErr {
  ok: false;
  response: NextResponse;
}

export type AdminGuard = AdminGuardOk | AdminGuardErr;

export async function requireOrgAdmin(orgSlug: string): Promise<AdminGuard> {
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', orgSlug)
    .maybeSingle<{ id: string }>();
  if (!org) {
    return { ok: false, response: NextResponse.json({ error: 'org not found' }, { status: 404 }) };
  }

  const { data: member } = await supabase
    .from('org_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', user.user.id)
    .maybeSingle<{ role: 'member' | 'admin' }>();
  if (!member || member.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'admin role required' }, { status: 403 }),
    };
  }

  return { ok: true, orgId: org.id, userId: user.user.id };
}

export async function resolveProject(orgId: string, projectSlug: string) {
  const supabase = await getSupabaseServer();
  return supabase
    .from('projects')
    .select('id, slug')
    .eq('organization_id', orgId)
    .eq('slug', projectSlug)
    .maybeSingle<{ id: string; slug: string }>();
}
