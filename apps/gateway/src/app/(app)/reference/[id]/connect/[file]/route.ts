/**
 * `GET /reference/<id>/connect/<file>` — a screenshot of a service's connect guide,
 * read from the plugin's folder, bundled or pinned (handbook accounts). Thin
 * adapter over `accounts.handlers.connectFile`: signed-in users only, 404 for
 * anything the registered plugin's guide does not declare.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; file: string }> },
): Promise<Response> {
  const { id, file } = await context.params;
  return (await getRoot()).accounts.handlers.connectFile(request, id, file);
}
