/**
 * `POST /accounts/<id>/shares/<shareId>/revoke` — revokes a share (terminal).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; shareId: string }> },
): Promise<Response> {
  const { id, shareId } = await params;
  return (await getRoot()).shares.handlers.revoke(request, id, shareId);
}
