/**
 * `POST /admin/users/local-link` — a single-use link for a sign-in account: to
 * create it (`kind=invite`) or to reset its password (`kind=reset`). Operator
 * only; the handler authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.signInAccountLink(request);
}
