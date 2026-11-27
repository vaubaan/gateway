/**
 * `GET /oauth/loopback` — the redirect of Vaubaan's installed-app clients, on
 * `http://127.0.0.1:<port>` (ADR local-instance-carries-installed-oauth-clients). A
 * connect's `state` is the accounts module's; any other is a sign-in's. Either way the
 * browser then goes on to the public URL.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const root = await getRoot();
  return (
    (await root.accounts.handlers.loopbackConnect(request)) ??
    root.auth.handlers.loopbackCallback(request)
  );
}
