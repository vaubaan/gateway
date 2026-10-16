/**
 * `POST /api/missions/<id>/limits` — the creator changes the limits of risks
 * the mission holds (quota per period, calls per rate window); creator only,
 * origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.setLimits(request, id);
}
