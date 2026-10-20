/**
 * `POST /admin/users/administrators/group` — names a group of a sign-in provider administrator.
 * Operator only; the handler authorizes by itself (ADR administrators-live-in-the-instance).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.addAdministratorGroup(request);
}
