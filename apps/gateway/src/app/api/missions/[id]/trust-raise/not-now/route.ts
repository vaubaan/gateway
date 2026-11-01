/**
 * `POST /api/missions/<id>/trust-raise/not-now` — the creator puts off a trust-raise
 * proposal until as many approvals again (risk model §4.7); creator only,
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
  return (await getRoot()).missions.handlers.snoozeTrustRaise(request, id);
}
