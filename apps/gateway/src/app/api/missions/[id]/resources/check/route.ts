/**
 * `POST /api/missions/<id>/resources/check` — "check now" on a mission card: the
 * discovery of one account of the mission, `{ account_id }`; the creator or an
 * owner of the account, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).accounts.handlers.checkMissionResources(request, id);
}
