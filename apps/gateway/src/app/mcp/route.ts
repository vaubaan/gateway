/**
 * `/mcp` — the execution MCP door (spec §4.1). Thin Next adapter over the
 * host-agnostic handler; `EXECUTION_DOOR_PATH` (`server/missions/bootstrap-kit.ts`)
 * names this path in the bootstrap kit.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).execution.handlers.mcp(request);
}

export { handle as GET, handle as POST, handle as DELETE };
