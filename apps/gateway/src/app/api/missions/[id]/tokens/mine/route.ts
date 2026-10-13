/**
 * `POST /api/missions/<id>/tokens/mine` — the signed-in user generates, or rotates, their
 * own token of the mission; the secret is in this answer only. Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.generateToken(request, id);
}
