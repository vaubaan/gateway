/**
 * `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata of the
 * instance's authorization server (management door, spec §4.1 bis). One-line
 * adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.authorizationServerMetadata(request);
}

export { handle as GET, handle as HEAD, handle as OPTIONS };
