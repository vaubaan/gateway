/**
 * GET /api/integrations/vercel/connect?org=<slug>
 *
 * Starts the Vercel Integration install flow. Vercel uses its own UI for
 * install (not raw OAuth2 authorize); we redirect to the integration's
 * marketplace URL with our state nonce. Vercel will redirect back to
 * `/api/integrations/vercel/callback` with `code` + `state` + the
 * `teamId` and `configurationId` of the install.
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

  const integrationSlug = process.env.VERCEL_INTEGRATION_SLUG;
  if (!integrationSlug) {
    return NextResponse.json(
      { error: 'server misconfigured: VERCEL_INTEGRATION_SLUG unset' },
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

  const installUrl = new URL(`https://vercel.com/integrations/${integrationSlug}/new`);
  installUrl.searchParams.set('state', state);
  return NextResponse.redirect(installUrl.toString());
}
