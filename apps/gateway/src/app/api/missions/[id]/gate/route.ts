/**
 * `POST /api/missions/<id>/gate` — the creator sets the gate of one accepted
 * risk (`auto` or `approval`) after issuance; creator only, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.setGate(request, id);
}
