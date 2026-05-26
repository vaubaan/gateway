/**
 * GET /api/integrations/supabase/connect?org=<slug>
 *
 * Starts the Supabase Management API OAuth flow (authorization_code grant).
 * Redirects to Supabase's authorize endpoint; the user picks which org/projects
 * to grant access to; Supabase redirects back to our callback with a `code`.
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

  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'server misconfigured: SUPABASE_OAUTH_CLIENT_ID unset' },
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

  const redirectUri = new URL('/api/integrations/supabase/callback', req.url).toString();
  const authorizeUrl = new URL('https://api.supabase.com/v1/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  return NextResponse.redirect(authorizeUrl.toString());
}
