/**
 * GET /api/integrations/vercel/connect?org=<slug>
 *
 * Starts the Vercel Connected App OAuth2 authorization flow. Standard
 * `response_type=code` authorize redirect; callback handler exchanges the
 * code for a long-lived access token via POST /v2/oauth/access_token.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireOrgAdmin } from '@/lib/auth/require-admin';
import { generateState } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('org');
  if (!slug) return NextResponse.json({ error: 'org query param required' }, { status: 400 });

  const guard = await requireOrgAdmin(slug);
  if (!guard.ok) return guard.response;

  const clientId = process.env.VERCEL_APP_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'server misconfigured: VERCEL_APP_CLIENT_ID unset' },
      { status: 503 },
    );
  }

  const state = generateState(guard.orgId);
  const cookieStore = await cookies();
  cookieStore.set('vbn_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 300,
    path: '/',
  });

  const redirectUri = new URL('/api/integrations/vercel/callback', req.url).toString();
  const authorizeUrl = new URL('https://vercel.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  return NextResponse.redirect(authorizeUrl.toString());
}
