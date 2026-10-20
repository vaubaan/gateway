/**
 * `POST /api/admin/setup/finish` — "Finish setup": revokes the install token once
 * the key is handed over and an administrator has a way in (ADR
 * administrators-live-in-the-instance, §8). Operator only, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.finishSetup(request);
}
