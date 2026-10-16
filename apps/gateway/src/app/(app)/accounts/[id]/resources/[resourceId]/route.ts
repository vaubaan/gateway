/**
 * `POST /connections/<id>/resources/<resourceId>` — the owner's edits on one
 * resource (display name, environment label, hidden flag, list settings).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; resourceId: string }> },
): Promise<Response> {
  const { id, resourceId } = await params;
  return (await getRoot()).connections.handlers.updateResource(request, id, resourceId);
}
