/**
 * `POST /oauth/token` — authorization-code and refresh-token grants of the
 * management door. A protocol endpoint: it reads no cookie. One-line adapter
 * over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.token(request);
}

export { handle as POST, handle as OPTIONS };
