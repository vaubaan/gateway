/**
 * GET /api/integrations/vercel/connect?org=<slug>
 *
 * Starts the Vercel Marketplace Integration install flow. Vercel's install URL
 * (https://vercel.com/integrations/<slug>/new) shows the user their teams and
 * the per-resource scope picker, then redirects back to the configured
 * Redirect URL with `?code=...&teamId=...&configurationId=...&state=...`.
 *
 * Slug here = the Integration's marketplace slug (e.g. `vaubaan`), NOT a
 * Connected App client_id. Connected Apps (cl_ prefix) are a different
 * primitive (SSO-only); we explicitly use Marketplace Integrations because
 * the upstream API tools need long-lived API access, not user identity.
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
