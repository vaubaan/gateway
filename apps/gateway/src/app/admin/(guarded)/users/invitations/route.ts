/**
 * `POST /admin/users/invitations` — invites an email address to sign in.
 * Operator only; the handler authorizes by itself.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.invite(request);
}
