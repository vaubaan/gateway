/**
 * GET /api/integrations/railway/connect?org=<slug>
 *
 * Starts the Railway OAuth flow (authorization_code grant + PKCE S256).
 * Redirects to Railway's authorize endpoint with `resource=https://mcp.railway.com`
 * (RFC 8707 audience binding) and `prompt=consent` (to guarantee a refresh_token
 * via the offline_access scope). The user grants workspace access; Railway
 * redirects back to our callback with a `code`.
 *
 * ADR : docs/decisions/railway-rewrap-remote-mcp.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { generatePkce, generateState } from '@/lib/oauth/state';
import {
  RAILWAY_AUTHORIZE_URL,
  RAILWAY_MCP_RESOURCE,
  RAILWAY_SCOPE,
  railwayRedirectUri,
} from '@/lib/oauth/railway';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('org');
  if (!slug) return NextResponse.json({ error: 'org query param required' }, { status: 400 });

  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const clientId = process.env.RAILWAY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'server misconfigured: RAILWAY_CLIENT_ID unset' },
      { status: 503 },
    );
  }

  const state = generateState(guard.orgId);
  const { verifier, challenge } = generatePkce();
  const cookieStore = await cookies();
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 300,
    path: '/',
  };
  cookieStore.set('vbn_oauth_state', state, cookieOpts);
  cookieStore.set('vbn_oauth_verifier', verifier, cookieOpts);

  const authorizeUrl = new URL(RAILWAY_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', railwayRedirectUri(req));
  authorizeUrl.searchParams.set('scope', RAILWAY_SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('resource', RAILWAY_MCP_RESOURCE);
  authorizeUrl.searchParams.set('prompt', 'consent');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  return NextResponse.redirect(authorizeUrl.toString());
}
