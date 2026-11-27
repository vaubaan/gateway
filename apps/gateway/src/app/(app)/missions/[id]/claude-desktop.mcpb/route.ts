/**
 * `GET /missions/<id>/claude-desktop.mcpb` — the file Claude Desktop installs to reach
 * the mission (ADR mission-key-reaches-an-agent-through-its-own-secret-store): a relay
 * to this gateway's `/mcp`, named after the mission, with no key inside. Signed-in
 * people of the mission only. One-line adapter.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.claudeDesktopBundle(request, id);
}
