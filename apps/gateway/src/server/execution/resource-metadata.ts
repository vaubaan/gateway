/**
 * `GET /.well-known/oauth-protected-resource` — the RFC 9728 document of the
 * execution door (`/mcp`).
 *
 * The door takes a static bearer, the mission key, and the instance runs no
 * OAuth authorization server (ADR
 * platform-management-is-a-plugin-on-the-execution-door). MCP clients probe this
 * URL on connect; some (Claude Code among them) do not send the configured
 * `Authorization` header when the probe is a 404. Answering 200 with an empty
 * `authorization_servers` tells them to use the bearer they were given and not
 * to attempt a registration.
 *
 * Served from any origin (`GET`, `HEAD`, the `OPTIONS` preflight), never cached.
 * It reads nothing of the request but its method.
 */
import { EXECUTION_DOOR_PATH } from '../missions';

const CORS = { 'Access-Control-Allow-Origin': '*' } as const;
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const CORS_ALLOWED_HEADERS = 'authorization, content-type, mcp-protocol-version';
const HTTP_NO_CONTENT = 204;
const HTTP_METHOD_NOT_ALLOWED = 405;
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/** The document: the door's URL, built on `public_url` (a sub-path kept, no doubled slash). */
export function executionResourceMetadata(publicUrl: URL): Record<string, unknown> {
  const base = publicUrl.href.replace(/\/+$/, '');
  return {
    resource: `${base}${EXECUTION_DOOR_PATH}`,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
  };
}

export function executionResourceMetadataResponse(publicUrl: URL, request: Request): Response {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: HTTP_NO_CONTENT,
      headers: {
        ...CORS,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
        'Access-Control-Max-Age': PREFLIGHT_MAX_AGE_SECONDS,
      },
    });
  }
  const headers = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: `this endpoint answers ${ALLOWED_METHODS}` }), {
      status: HTTP_METHOD_NOT_ALLOWED,
      headers: { ...headers, Allow: ALLOWED_METHODS },
    });
  }
  const body =
    request.method === 'HEAD' ? null : JSON.stringify(executionResourceMetadata(publicUrl));
  return new Response(body, { status: 200, headers });
}
