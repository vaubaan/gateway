/**
 * `POST /api/admin/setup/local` — the second screen of a local instance's setup: the
 * person's email and password become the administrator's sign-in account, the setup
 * ends and they are signed in (spec §7.1). The holder of the setup link only,
 * origin-checked; absent outside local mode.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.localSetup(request);
}
