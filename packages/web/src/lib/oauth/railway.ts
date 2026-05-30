/**
 * Railway OAuth constants + helpers shared by the connect/callback routes.
 *
 * ADR : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * The `resource` param (RFC 8707) binds the issued token to the MCP audience
 * `https://mcp.railway.com`. Without it the token is refused by the MCP.
 */

import type { NextRequest } from 'next/server';

export const RAILWAY_AUTHORIZE_URL = 'https://backboard.railway.com/oauth/auth';
export const RAILWAY_TOKEN_URL = 'https://backboard.railway.com/oauth/token';
/** RFC 8707 resource indicator — the MCP audience. */
export const RAILWAY_MCP_RESOURCE = 'https://mcp.railway.com';
export const RAILWAY_SCOPE = 'openid offline_access workspace:member';

/**
 * The exact redirect_uri registered on the Auth app. Railway requires HTTPS and
 * rejects `localhost` (loopback must be `https://127.0.0.1`). In production the
 * `req.url` origin (`https://vaubaan.com`) matches a registered URI ; in local
 * dev set `RAILWAY_REDIRECT_URI=https://127.0.0.1:3000/api/integrations/railway/callback`.
 */
export function railwayRedirectUri(req: NextRequest): string {
  return (
    process.env.RAILWAY_REDIRECT_URI ??
    new URL('/api/integrations/railway/callback', req.url).toString()
  );
}
