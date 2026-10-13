/**
 * `GET /auth/login?return_to=` — starts the OIDC sign-in (redirect to the IdP).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.loginStart(request);
}
