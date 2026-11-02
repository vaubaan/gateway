/**
 * `POST /api/admin/telemetry/instance-id` — the operator regenerates the
 * instance identifier of the daily telemetry profile, stored in
 * `instance_config`. Operator only, origin-checked; the handler authorizes by
 * itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).telemetry.handlers.regenerateInstanceId(request);
}
