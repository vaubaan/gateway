/**
 * `POST /api/notifications/devices` — this browser's push subscription, posted by the
 * person's click on Settings → Notifications or on the home. Human session only (a bearer
 * is refused), origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).notifications.handlers.add(request);
}
