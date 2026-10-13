/**
 * `GET /oauth/authorize` — the authorization endpoint of the management door:
 * the request of an OAuth client, answered by the sign-in, then the consent
 * screen. The user's answer is posted to `./decision`. One-line adapter over
 * the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.authorize(request);
}
