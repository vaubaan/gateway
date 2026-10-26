/**
 * `POST /api/missions/<id>/edit` — the creator edits the whole mission after
 * issuance (`{ draft, revision }`); creator only, origin-checked. ADR
 * mission-editable-after-issuance.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).missions.handlers.edit(request, id);
}
