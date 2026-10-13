/**
 * `GET /auth/callback` — the OIDC redirect URI (`<public_url>/auth/callback`).
 * The handler rebuilds the callback URL from `public_url`; only the query
 * string of this request is used.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.loginCallback(request);
}
