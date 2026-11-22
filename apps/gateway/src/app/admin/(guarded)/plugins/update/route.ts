/**
 * `POST /admin/plugins/update` — Administration › Plugins: updates or installs one or more
 * plugins from the catalog, each downloaded, verified and activated on trial in one act
 * (intent "Update my installed plugins in a few clicks"). Operator only; the handler
 * authorizes by itself and audits. One-line adapter over the host-agnostic handler
 * (`server/plugins/handlers.ts`).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).pluginInstall.handlers.update(request);
}
