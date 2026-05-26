'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';

export interface CreateOrgResult {
  ok: false;
  error: string;
}

export async function createOrg(
  _prev: CreateOrgResult | null,
  formData: FormData,
): Promise<CreateOrgResult> {
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  if (!name || !slug) return { ok: false, error: 'name and slug are required' };
  if (!/^[a-z0-9](-?[a-z0-9])*$/.test(slug)) {
    return { ok: false, error: 'slug must match ^[a-z0-9](-?[a-z0-9])*$' };
  }

  // Auth check via the cookie-bound client (the RLS-aware one).
  const auth = await getSupabaseServer();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) return { ok: false, error: 'not authenticated — please log in again' };

  // Insert via service-role : same trust model as the OAuth provider callback —
  // we've authenticated the user above, so we can bypass RLS to atomically
  // create the org + admin membership.
  const svc = getSupabaseServiceClient();

  const { data: org, error: orgErr } = await svc
    .from('organizations')
    .insert({ name, slug })
    .select('id, slug')
    .single<{ id: string; slug: string }>();
  if (orgErr || !org) {
    return { ok: false, error: orgErr?.message ?? 'insert returned no row' };
  }

  const { error: memErr } = await svc
    .from('org_members')
    .insert({ organization_id: org.id, user_id: userData.user.id, role: 'admin' });
  if (memErr)
    return { ok: false, error: `org created but member insert failed: ${memErr.message}` };

  redirect(`/orgs/${org.slug}`);
}
