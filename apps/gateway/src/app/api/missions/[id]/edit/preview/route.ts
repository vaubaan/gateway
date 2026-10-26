/**
 * `POST /api/missions/<id>/edit/preview` — what an edit of the mission would
 * change, or why it would be refused; writes nothing. Creator only.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.previewEdit(request, id);
}
