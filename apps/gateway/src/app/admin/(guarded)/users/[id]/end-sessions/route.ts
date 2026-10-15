/**
 * `POST /admin/users/<id>/end-sessions` — ends every web session of a user ("sign out everywhere").
 * Operator only; the handler authorizes by itself.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return (await getRoot()).users.handlers.endSessions(request, id);
}
