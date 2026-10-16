/**
 * `POST /admin/users/invitations/remove` — removes an address from the invitation list.
 * Operator only; the handler authorizes by itself.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.removeInvitation(request);
}
