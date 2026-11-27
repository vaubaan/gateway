/**
 * `GET /connections/loopback/done?state=` — where the loopback sends the browser after a
 * connect through Vaubaan's installed client: the person's own browser goes on to the
 * service's callback, any other is told to go back to Vaubaan.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).accounts.handlers.loopbackConnectDone(request);
}
