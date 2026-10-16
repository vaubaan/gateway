/**
 * `POST /api/admin/instance-name` — the instance's name, set by an
 * administrator and stored in `instance_config`. Operator only,
 * origin-checked; the handler authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).instance.handlers.setName(request);
}
