/**
 * OAuth 2.0 Protected Resource Metadata — `GET /.well-known/oauth-protected-resource`.
 *
 * RFC 9728. Advertises that `/mcp` is a protected resource that accepts
 * Bearer tokens in the `Authorization` header and has *no* OAuth
 * authorization server. Clients should use the static bearer they were
 * already given (`vbn_live_*`) and not attempt dynamic client registration.
 *
 * Why this exists : Claude Code (and other MCP clients) probe this URL on
 * connect. When it 404s, Claude Code's auth fallback misbehaves and never
 * sends the configured `Authorization` header — see
 * https://github.com/anthropics/claude-code/issues/59467. Returning an
 * explicit 200 with `authorization_servers: []` short-circuits the probe
 * and lets the bearer header through.
 */

import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function OPTIONS(): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }));
}

export function GET(req: NextRequest): NextResponse {
  const origin = new URL(req.url).origin;
  return withCors(
    NextResponse.json({
      resource: `${origin}/mcp`,
      authorization_servers: [],
      bearer_methods_supported: ['header'],
      resource_documentation: origin,
    }),
  );
}
