/**
 * `POST /api/missions/<id>/permissions` — the creator adds or removes risks,
 * optionally answering a permission request; human session and origin checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.changePermissions(request, id);
}
