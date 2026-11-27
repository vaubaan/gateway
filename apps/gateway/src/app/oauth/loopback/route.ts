/**
 * `GET /oauth/loopback` — the redirect of Vaubaan's installed-app clients, on
 * `http://127.0.0.1:<port>` (ADR local-instance-carries-installed-oauth-clients). The
 * record `state` names finishes the exchange; the browser then goes on to the public URL.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.loopbackCallback(request);
}
