/**
 * `POST /admin/plugins/install-catalog` — Administration › Plugins: downloads a version
 * from the catalog, keeps it only if the catalog signed it, pending (intent "Install a
 * catalog plugin in one click"). Operator only; the handler authorizes by itself and
 * audits. One-line adapter over the host-agnostic handler (`server/plugins/handlers.ts`).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).pluginInstall.handlers.installCatalog(request);
}
