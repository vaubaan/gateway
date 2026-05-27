/**
 * GET /api/integrations/supabase/callback?code=...&state=...
 *
 * Supabase OAuth callback. Exchanges `code` for `access_token` (1h) and a
 * `refresh_token`. Persists both encrypted + `expires_at`. The runtime mint
 * helper refreshes the access_token via the refresh_token when it's near
 * expiry (cf. docs/decisions/oauth-app-install-per-provider.md).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeStateOrgId } from '@/lib/oauth/state';
import { encodeByteaHex } from '@/lib/providers/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  const code = params.get('code');

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

  const clientId = process.env.SUPABASE_APP_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fallback.searchParams.set('error', 'server misconfigured: SUPABASE_APP_* unset');
    return NextResponse.redirect(fallback);
  }

  const redirectUri = new URL('/api/integrations/supabase/callback', req.url).toString();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const tokenRes = await fetch('https://api.supabase.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    const body = (await tokenRes.text()).slice(0, 200);
    fallback.searchParams.set(
      'error',
      `Supabase token exchange failed (${tokenRes.status}): ${body}`,
    );
    return NextResponse.redirect(fallback);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString();

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
      provider: 'supabase',
      status: 'connected',
      access_token_encrypted: encodeByteaHex(tokenJson.access_token),
      refresh_token_encrypted: encodeByteaHex(tokenJson.refresh_token),
      expires_at: expiresAt,
      connected_by_user_id: userData.user.id,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,provider' },
  );
  if (insertErr) {
    redirect.searchParams.set('error', `persist failed: ${insertErr.message}`);
    return NextResponse.redirect(redirect);
  }

  redirect.searchParams.set('connected', 'supabase');
  return NextResponse.redirect(redirect);
}
