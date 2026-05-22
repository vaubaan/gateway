import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeStateOrgId } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  const installationId = params.get('installation_id');

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('vbn_oauth_state')?.value;
  cookieStore.delete('vbn_oauth_state');

  const baseRedirect = new URL(`/orgs/${slug}`, req.url);

  if (!state || !installationId || state !== expectedState) {
    baseRedirect.searchParams.set('error', 'invalid OAuth state — please retry');
    return NextResponse.redirect(baseRedirect);
  }

  const stateOrgId = decodeStateOrgId(state);
  if (!stateOrgId) {
    baseRedirect.searchParams.set('error', 'state payload malformed');
    return NextResponse.redirect(baseRedirect);
  }

  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return NextResponse.redirect(new URL('/login', req.url));

  // Persist via service client to bypass RLS (we just authenticated the admin).
  const svc = getSupabaseServiceClient();
  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: stateOrgId,
      provider: 'github',
      status: 'connected',
      installation_id: installationId,
      connected_by_user_id: user.user.id,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,provider' },
  );

  if (insertErr) {
    baseRedirect.searchParams.set('error', `persist failed: ${insertErr.message}`);
    return NextResponse.redirect(baseRedirect);
  }

  baseRedirect.searchParams.set('connected', 'github');
  return NextResponse.redirect(baseRedirect);
}
