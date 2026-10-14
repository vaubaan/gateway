/**
 * `/git/**` — the git remote (spec §4.1 bis). Thin Next adapter over the
 * host-agnostic door (`server/git/door.ts`). The proxy (`src/proxy.ts`) does
 * not run on this path: it would buffer the pack of a push in memory.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).git.handle(request);
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
