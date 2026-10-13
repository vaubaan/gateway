/**
 * `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata of the
 * execution door.
 *
 * The execution door (`/mcp`) takes a static bearer, the mission token, and has
 * no OAuth authorization server. MCP clients probe this URL on connect; some
 * (Claude Code among them) do not send the configured `Authorization` header
 * when the probe is a 404. Answering 200 with an empty `authorization_servers`
 * tells them to use the bearer they were given and not to attempt a
 * registration. The management door (P2.3) will publish its own metadata under
 * its own path.
 */
import { getRoot } from '@/server/compose';
import { EXECUTION_DOOR_PATH } from '@/server/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { config } = await getRoot();
  const base = config.publicUrl.href.replace(/\/+$/, '');
  return Response.json(
    {
      resource: `${base}${EXECUTION_DOOR_PATH}`,
      authorization_servers: [],
      bearer_methods_supported: ['header'],
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
