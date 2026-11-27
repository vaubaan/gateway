/**
 * `POST /api/missions/<id>/first-call` — when the reader's own key of the mission was
 * last used, `null` while it never was (spec §7.4): what the page that shows the key
 * polls to say the agent's first call arrived. One-line adapter.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.firstCall(request, id);
}
