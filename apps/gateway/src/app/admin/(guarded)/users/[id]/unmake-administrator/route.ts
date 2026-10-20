/**
 * `POST /admin/users/<id>/unmake-administrator` — the user no longer administers (refused for the last way in).
 * Operator only; the handler authorizes by itself (ADR administrators-live-in-the-instance).
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
  return (await getRoot()).users.handlers.unmakeAdministrator(request, id);
}
