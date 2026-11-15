/**
 * `POST /api/missions/<id>/versions/<number>/restore` — the creator brings a past
 * version of the mission's configuration back, as a new version; creator only,
 * origin-checked (spec §4.2 "History").
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; number: string }> },
): Promise<Response> {
  const { id, number } = await context.params;
  return (await getRoot()).missions.handlers.restoreVersion(request, id, number);
}
