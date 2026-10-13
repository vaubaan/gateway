/**
 * `/mcp/manage` — the management MCP door (spec §4.1 bis), authenticated by a
 * delegated access token: read the user's authority, preview a policy, issue,
 * rotate or revoke missions in the user's name (`server/management`).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).management.handlers.mcp(request);
}

export { handle as GET, handle as POST, handle as DELETE };
