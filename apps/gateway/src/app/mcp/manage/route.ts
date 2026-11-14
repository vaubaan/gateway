/**
 * `/mcp/manage` — the retired management door (ADR
 * platform-management-is-a-plugin-on-the-execution-door): 404 with a JSON hint
 * pointing to the `vaubaan__*` tools of `/mcp`. It needs no root.
 */
import { retiredManagementDoorResponse } from '@/server/execution/retired-door';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(): Promise<Response> {
  return retiredManagementDoorResponse();
}

export { handle as GET, handle as POST, handle as DELETE };
