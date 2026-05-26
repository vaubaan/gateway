/**
 * Shared membership guards for REST routes.
 *
 *   - requireOrgMember(orgSlug)  : user must belong to the org (full RW model)
 *   - requireOrgOwner(orgSlug)   : user must be the org's owner_id
 *                                  (used only for ownership transfer)
 *
 * Returns the org id (+ owner id) on success, or a 401/403/404 NextResponse otherwise.
 */

import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export interface OrgMemberGuardOk {
  ok: true;
  orgId: string;
  ownerId: string;
  userId: string;
}

export interface OrgMemberGuardErr {
  ok: false;
  response: NextResponse;
}

export type OrgMemberGuard = OrgMemberGuardOk | OrgMemberGuardErr;

export async function requireOrgMember(orgSlug: string): Promise<OrgMemberGuard> {
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('id, owner_id')
    .eq('slug', orgSlug)
    .maybeSingle<{ id: string; owner_id: string }>();
  if (!org) {
    return { ok: false, response: NextResponse.json({ error: 'org not found' }, { status: 404 }) };
  }

  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('organization_id', org.id)
    .eq('user_id', user.user.id)
    .maybeSingle<{ user_id: string }>();
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'org membership required' }, { status: 403 }),
    };
  }

  return { ok: true, orgId: org.id, ownerId: org.owner_id, userId: user.user.id };
}

export async function requireOrgOwner(orgSlug: string): Promise<OrgMemberGuard> {
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard;
  if (guard.userId !== guard.ownerId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'owner role required' }, { status: 403 }),
    };
  }
  return guard;
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
