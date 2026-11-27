/**
 * `GET /auth/loopback/done` — where the loopback sends the browser on: the browser that
 * started the flow completes it; any other is told to go back to Vaubaan.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.loopbackDone(request);
}
