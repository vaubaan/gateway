/**
 * `GET /.well-known/oauth-protected-resource/mcp/manage` — RFC 9728 metadata
 * of the management door: its resource identifier and the authorization
 * server that issues its tokens (this instance). The path-less document next
 * to it describes the execution door, which has no authorization server.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.protectedResourceMetadata(request);
}

export { handle as GET, handle as HEAD, handle as OPTIONS };
