/**
 * GET /api/integrations/railway/callback?code=...&state=...
 *
 * Railway OAuth callback. Exchanges the `code` (with the PKCE verifier from the
 * single-use cookie and `resource=https://mcp.railway.com` audience binding)
 * for an access_token (1h) + refresh_token, then upserts the provider_admins
 * row. Tokens are encrypted via app-level libsodium AEAD per-org encryption
 * (see docs/decisions/per-org-encryption-app-level.md).
 *
 * ADR : docs/decisions/railway-rewrap-remote-mcp.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeStateOrgId } from '@/lib/oauth/state';
import { RAILWAY_MCP_RESOURCE, RAILWAY_TOKEN_URL, railwayRedirectUri } from '@/lib/oauth/railway';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = params.get('state');
  const code = params.get('code');

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('vbn_oauth_state')?.value;
  const verifier = cookieStore.get('vbn_oauth_verifier')?.value;
  cookieStore.delete('vbn_oauth_state');
  cookieStore.delete('vbn_oauth_verifier');

  const fallback = new URL('/dashboard', req.url);

  if (!state || !code || state !== expectedState) {
    fallback.searchParams.set('error', 'invalid OAuth state — please retry');
    return NextResponse.redirect(fallback);
  }
  if (!verifier) {
    fallback.searchParams.set('error', 'missing PKCE verifier — please retry');
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

  const clientId = process.env.RAILWAY_CLIENT_ID;
  const clientSecret = process.env.RAILWAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fallback.searchParams.set('error', 'server misconfigured: RAILWAY_CLIENT_* unset');
    return NextResponse.redirect(fallback);
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch(RAILWAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: railwayRedirectUri(req),
      code_verifier: verifier,
      resource: RAILWAY_MCP_RESOURCE,
    }),
  });
  if (!tokenRes.ok) {
    const body = (await tokenRes.text()).slice(0, 200);
    fallback.searchParams.set(
      'error',
      `Railway token exchange failed (${tokenRes.status}): ${body}`,
    );
    return NextResponse.redirect(fallback);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
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

  const upsertPayload: {
    organization_id: string;
    provider: 'railway';
    status: 'connected';
    access_token_encrypted: string;
    connected_by_user_id: string;
    connected_at: string;
    refresh_token_encrypted?: string;
    expires_at?: string;
  } = {
    organization_id: orgId,
    provider: 'railway',
    status: 'connected',
    access_token_encrypted: encodeByteaHexRaw(
      await encryptProviderSecret(orgId, tokenJson.access_token),
    ),
    connected_by_user_id: userData.user.id,
    connected_at: new Date().toISOString(),
  };
  if (tokenJson.refresh_token) {
    upsertPayload.refresh_token_encrypted = encodeByteaHexRaw(
      await encryptProviderSecret(orgId, tokenJson.refresh_token),
    );
  }
  if (expiresAt) upsertPayload.expires_at = expiresAt;

  const { error: insertErr } = await svc
    .from('provider_admins')
    .upsert(upsertPayload, { onConflict: 'organization_id,provider' });
  if (insertErr) {
    redirect.searchParams.set('error', `persist failed: ${insertErr.message}`);
    return NextResponse.redirect(redirect);
  }

  redirect.searchParams.set('connected', 'railway');
  return NextResponse.redirect(redirect);
}
