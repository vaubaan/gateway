/**
 * GET /api/integrations/github/connect?org=<slug>
 *
 * Starts the GitHub App install flow. Verifies the caller is an admin of the
 * target org, mints an OAuth `state` nonce (5-min single-use cookie), and
 * redirects the browser to the App's install URL on github.com.
 *
 * Single fixed URL so the GitHub App "Setup URL" can be configured statically.
 * Slug is preserved via state (encodes orgId) and re-resolved by the callback.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireOrgAdmin } from '@/lib/auth/require-admin';
import { generateState } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('org');
  if (!slug) {
    return NextResponse.json({ error: 'org query param required' }, { status: 400 });
  }

  const guard = await requireOrgAdmin(slug);
  if (!guard.ok) return guard.response;

  const appSlug = process.env.GITHUB_APP_SLUG ?? 'vaubaan-gateway';
  const state = generateState(guard.orgId);

  const cookieStore = await cookies();
  cookieStore.set('vbn_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 300,
    path: '/',
  });

  const installUrl = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  installUrl.searchParams.set('state', state);
  return NextResponse.redirect(installUrl.toString());
}
