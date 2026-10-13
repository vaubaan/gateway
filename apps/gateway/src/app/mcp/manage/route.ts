/**
 * `/mcp/manage` — the management MCP door (spec §4.1 bis), authenticated by a
 * delegated access token. Until feature P2.4 brings its tools, the handler is
 * the authorization server's placeholder: the real admission gate in front of
 * an MCP server that lists no tool.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).management.handlers.mcp(request);
}

export { handle as GET, handle as POST, handle as DELETE };
