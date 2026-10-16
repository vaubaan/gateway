/**
 * `POST /api/admin/telemetry` — the operator's telemetry toggle, stored in
 * `instance_config`. Operator only, origin-checked; the handler authorizes
 * by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).telemetry.handlers.setEnabled(request);
}
