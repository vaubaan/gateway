/**
 * `POST /api/missions/<id>/tokens` — the creator creates a named token (`{ name }`); the
 * secret is in this answer only. Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.createNamedToken(request, id);
}
