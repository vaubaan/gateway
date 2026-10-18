/**
 * `POST /api/admin/master-key/handed-over` — the administrator confirms having
 * kept the generated key in a safe place; the setup goes on. Operator only,
 * origin-checked; the handler authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).masterKey.handlers.confirmHandover(request);
}
