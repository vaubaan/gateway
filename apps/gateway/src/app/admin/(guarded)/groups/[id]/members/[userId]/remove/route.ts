/**
 * `POST /admin/groups/<id>/members/<userId>/remove` — removes a member from a local group.
 * Operator only; the handler authorizes by itself.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  const { id, userId } = await params;
  return (await getRoot()).groups.handlers.removeMember(request, id, userId);
}
