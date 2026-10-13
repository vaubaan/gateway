/**
 * `POST /oauth/revoke` — token revocation (RFC 7009). A protocol endpoint: it
 * reads no cookie. One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.revoke(request);
}

export { handle as POST, handle as OPTIONS };
