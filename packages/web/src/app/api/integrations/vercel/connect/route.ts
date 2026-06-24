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
import crypto from 'node:crypto';
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

  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const cookieStore = await cookies();
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 300,
    path: '/',
  };
  const vercelTeam = req.nextUrl.searchParams.get('vercel_team');

  cookieStore.set('vbn_oauth_state', state, cookieOpts);
  cookieStore.set('vbn_pkce_verifier', codeVerifier, cookieOpts);
  if (vercelTeam) cookieStore.set('vbn_vercel_team', vercelTeam, cookieOpts);

  const redirectUri = new URL('/api/integrations/vercel/callback', req.url).toString();
  const authorizeUrl = new URL('https://vercel.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid offline_access');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (vercelTeam) authorizeUrl.searchParams.set('team_id', vercelTeam);
  return NextResponse.redirect(authorizeUrl.toString());
}
