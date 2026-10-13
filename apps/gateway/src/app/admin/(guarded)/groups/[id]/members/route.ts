/**
 * `POST /admin/groups/<id>/members` — adds a member (by email) to a local group. Operator
 * only; the handler authorizes by itself.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).groups.handlers.addMember(request, (await params).id);
}
