/**
 * GET /api/integrations/vercel/connect?org=<slug>
 *
 * Starts the Vercel Connected App OAuth flow. Redirects the user to
 * `https://vercel.com/oauth/authorize` which shows a consent screen,
 * then redirects back to /api/integrations/vercel/callback with `?code=...&state=...`.
 *
 * The Connected App token acts on behalf of the user (full API access),
 * unlike Marketplace Integration tokens which are scoped to integration-level
 * permissions and lack access to endpoints like runtime logs.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { generateState } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('org');
  if (!slug) return NextResponse.json({ error: 'org query param required' }, { status: 400 });

  const guard = await requireOrgMember(slug);
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
  authorizeUrl.searchParams.set('scope', 'openid offline_access');
  authorizeUrl.searchParams.set('state', state);
  return NextResponse.redirect(authorizeUrl.toString());
}
