/**
 * `POST /api/notifications/mail` — switches my mail notifications on or off (the Settings
 * form). Human session only (a bearer is refused), origin-checked, body bounded.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).notifications.handlers.setMail(request);
}
