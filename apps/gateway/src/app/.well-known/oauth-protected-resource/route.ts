/**
 * `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata of the
 * execution door.
 *
 * The execution door (`/mcp`) takes a static bearer, the mission token, and has
 * no OAuth authorization server. MCP clients probe this URL on connect; some
 * (Claude Code among them) do not send the configured `Authorization` header
 * when the probe is a 404. Answering 200 with an empty `authorization_servers`
 * tells them to use the bearer they were given and not to attempt a
 * registration. The management door publishes its own metadata under its own
 * path (`./mcp/manage/route.ts`), where an MCP client looks first.
 *
 * The document and its answer (methods, CORS) are built by the authorization
 * server module, like the two other discovery documents.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).oauth.discovery.executionResource(request);
}

export { handle as GET, handle as HEAD, handle as OPTIONS };
