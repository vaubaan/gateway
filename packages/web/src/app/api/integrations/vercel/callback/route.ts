/**
 * GET /api/integrations/vercel/callback?code=...&state=...
 *
 * Vercel Connected App OAuth callback. Exchanges the authorization `code` for
 * an `access_token` + `refresh_token` via POST /login/oauth/token, then upserts
 * the provider_admins row with encrypted tokens.
 *
 * The access_token (vca_*) expires in ~1h; the adapter refreshes it
 * pre-emptively using the refresh_token (vcr_*).
 *
 * Encryption: app-level libsodium AEAD per-org — see docs/decisions/per-org-encryption-app-level.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeStateOrgId } from '@/lib/oauth/state';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  const code = params.get('code');
  const teamId = params.get('teamId');

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('vbn_oauth_state')?.value;
  const codeVerifier = cookieStore.get('vbn_pkce_verifier')?.value;
  const vercelTeamFromCookie = cookieStore.get('vbn_vercel_team')?.value ?? null;
  cookieStore.delete('vbn_oauth_state');
  cookieStore.delete('vbn_pkce_verifier');
  cookieStore.delete('vbn_vercel_team');

  const fallback = new URL('/dashboard', req.url);

  if (!state || !code || state !== expectedState || !codeVerifier) {
    fallback.searchParams.set('error', 'invalid OAuth state or missing PKCE verifier — please retry');
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

  const tokenRes = await fetch('https://api.vercel.com/login/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
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
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    team_id?: string;
    expires_in?: number;
  };

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

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
    : null;

  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: orgId,
      provider: 'vercel',
      status: 'connected',
      team_id: vercelTeamFromCookie ?? teamId ?? tokenJson.team_id ?? null,
      access_token_encrypted: encodeByteaHexRaw(
        await encryptProviderSecret(orgId, tokenJson.access_token),
      ),
      refresh_token_encrypted: tokenJson.refresh_token
        ? encodeByteaHexRaw(await encryptProviderSecret(orgId, tokenJson.refresh_token))
        : null,
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

  redirect.searchParams.set('connected', 'vercel');
  return NextResponse.redirect(redirect);
}
