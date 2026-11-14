/** `POST /admin/users/first-administrator` — the setup creates the first administrator's sign-in account. Operator only. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.createFirstAdministrator(request);
}
