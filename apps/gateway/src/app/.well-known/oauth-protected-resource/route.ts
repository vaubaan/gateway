/**
 * `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata of the
 * execution door.
 *
 * The execution door (`/mcp`) takes a static bearer, the mission token, and has
 * no OAuth authorization server. MCP clients probe this URL on connect; some
 * (Claude Code among them) do not send the configured `Authorization` header
 * when the probe is a 404. Answering 200 with an empty `authorization_servers`
 * tells them to use the bearer they were given and not to attempt a
 * registration.
 *
 * The document and its answer (methods, CORS) are built by the execution
 * module (`server/execution/resource-metadata.ts`).
 */
import { getRoot } from '@/server/compose';
import { executionResourceMetadataResponse } from '@/server/execution/resource-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return executionResourceMetadataResponse((await getRoot()).config.publicUrl, request);
}

export { handle as GET, handle as HEAD, handle as OPTIONS };
