/**
 * `POST /api/notifications/addresses` — adds one of my messaging addresses (the Settings
 * form): a test message leaves at once, the address is kept only when the service took it.
 * Human session only (a bearer is refused), origin-checked, body bounded.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).notifications.handlers.addAddress(request);
}
