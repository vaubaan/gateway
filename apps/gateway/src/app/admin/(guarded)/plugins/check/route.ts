/**
 * `POST /admin/plugins/check` — "Check now" on Administration › Plugins: reads the
 * versions feed at once. Operator only; the handler authorizes by itself (the
 * Administration layout does not cover route handlers). Not audited: it changes
 * nothing (`server/updates/handlers.ts`). One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).updates.handlers.checkNow(request);
}
