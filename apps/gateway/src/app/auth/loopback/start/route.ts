/**
 * `POST /auth/loopback/start` — starts a flow of one of Vaubaan's installed-app clients
 * (`{ signInProvider, purpose, return_to }`): answers the consent address and sets the
 * cookie that binds the flow to this window. One-line adapter over the handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.loopbackStart(request);
}
