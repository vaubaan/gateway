/**
 * `POST /oauth/register` — dynamic client registration (RFC 7591), subject to
 * the registration policy of the instance. A protocol endpoint: it reads no
 * cookie. One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.register(request);
}

export { handle as POST, handle as OPTIONS };
