/**
 * GET /api/integrations/vercel/callback?code=...&state=...&teamId=...&configurationId=...
 *
 * Vercel Integration callback. Exchanges the install `code` for a long-lived
 * `access_token`, then upserts the provider_admins row with `team_id` and
 * the encrypted token (v0 trust model: bytea but no real crypto yet — see
 * docs/decisions/trust-model-clear-at-rest-idp-style.md).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeStateOrgId } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  const code = params.get('code');
  const teamId = params.get('teamId');

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('vbn_oauth_state')?.value;
  cookieStore.delete('vbn_oauth_state');

  const fallback = new URL('/dashboard', req.url);

  if (!state || !code || state !== expectedState) {
    fallback.searchParams.set('error', 'invalid OAuth state — please retry');
    return NextResponse.redirect(fallback);
  }

  const orgId = decodeStateOrgId(state);
  if (!orgId) {
    fallback.searchParams.set('error', 'state payload malformed');
    return NextResponse.redirect(fallback);
  }

  const auth = await getSupabaseServer();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) return NextResponse.redirect(new URL('/login', req.url));

  const clientId = process.env.VERCEL_APP_CLIENT_ID;
  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fallback.searchParams.set('error', 'server misconfigured: VERCEL_APP_* unset');
    return NextResponse.redirect(fallback);
  }

  const redirectUri = new URL('/api/integrations/vercel/callback', req.url).toString();

  const tokenRes = await fetch('https://api.vercel.com/v2/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    const body = (await tokenRes.text()).slice(0, 200);
    fallback.searchParams.set(
      'error',
      `Vercel token exchange failed (${tokenRes.status}): ${body}`,
    );
    return NextResponse.redirect(fallback);
  }
  const tokenJson = (await tokenRes.json()) as { access_token: string; team_id?: string };

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
  const redirect = new URL(`/orgs/${org.slug}`, req.url);

  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: orgId,
      provider: 'vercel',
      status: 'connected',
      team_id: teamId ?? tokenJson.team_id ?? null,
      access_token_encrypted: Buffer.from(tokenJson.access_token, 'utf8'),
      connected_by_user_id: userData.user.id,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,provider' },
  );
  if (insertErr) {
    redirect.searchParams.set('error', `persist failed: ${insertErr.message}`);
    return NextResponse.redirect(redirect);
  }

  redirect.searchParams.set('connected', 'vercel');
  return NextResponse.redirect(redirect);
}
