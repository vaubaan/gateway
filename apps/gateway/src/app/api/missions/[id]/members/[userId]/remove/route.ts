/**
 * `POST /api/missions/<id>/members/<userId>/remove` — the creator removes a member; their
 * token is revoked with them. Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; userId: string }> },
): Promise<Response> {
  const { id, userId } = await context.params;
  return (await getRoot()).missions.handlers.removeMember(request, id, userId);
}
