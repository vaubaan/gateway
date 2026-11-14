/**
 * `POST /api/missions/<id>/revoke` — the creator; or, while the mission is orphaned,
 * an owner of one of its accounts (spec §2.3). Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.revoke(request, id);
}
