/**
 * `POST /api/missions/<id>/leave` — a teammate leaves the mission; their key
 * is revoked with it.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.leave(request, id);
}
