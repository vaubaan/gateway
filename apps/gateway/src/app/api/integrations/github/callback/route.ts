/**
 * GET /api/integrations/github/callback?installation_id=...&state=...&setup_action=install
 *
 * GitHub App "Setup URL" target. Fixed (slug-agnostic) so the App config on
 * github.com is stable. State encodes orgId — we decode it, persist the
 * provider_admins row, then redirect to the org page.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeStateOrgId } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  const installationId = params.get('installation_id');

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('vbn_oauth_state')?.value;
  cookieStore.delete('vbn_oauth_state');

  const fallback = new URL('/dashboard', req.url);

  if (!state || !installationId || state !== expectedState) {
    fallback.searchParams.set('error', 'invalid OAuth state — please retry');
    return NextResponse.redirect(fallback);
  }

  const orgId = decodeStateOrgId(state);
  if (!orgId) {
    fallback.searchParams.set('error', 'state payload malformed');
    return NextResponse.redirect(fallback);
  }

  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return NextResponse.redirect(new URL('/login', req.url));

  const svc = getSupabaseServiceClient();

  const { data: org } = await svc
    .from('organizations')
    .select('slug')
    .eq('id', orgId)
    .maybeSingle<{ slug: string }>();
  if (!org) {
    fallback.searchParams.set('error', 'org not found for state');
    return NextResponse.redirect(fallback);
  }

  const redirect = new URL(`/orgs/${org.slug}/providers`, req.url);

  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: orgId,
      provider: 'github',
      status: 'connected',
      installation_id: installationId,
      connected_by_user_id: user.user.id,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,provider' },
  );

  if (insertErr) {
    redirect.searchParams.set('error', `persist failed: ${insertErr.message}`);
    return NextResponse.redirect(redirect);
  }

  redirect.searchParams.set('connected', 'github');
  return NextResponse.redirect(redirect);
}
