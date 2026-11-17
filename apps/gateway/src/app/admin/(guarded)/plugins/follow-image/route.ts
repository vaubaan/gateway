/**
 * `POST /admin/plugins/follow-image` — Administration › Plugins: the plugin stops using its installed version from the next start (ADR
 * plugins-activated-by-an-administrator-on-trial). Operator only; the handler authorizes by
 * itself (the Administration layout does not cover route handlers) and audits. One-line
 * adapter over the host-agnostic handler (`server/plugins/handlers.ts`).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).pluginInstall.handlers.followImage(request);
}
