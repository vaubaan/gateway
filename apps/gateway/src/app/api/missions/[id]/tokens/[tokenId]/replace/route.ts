/**
 * `POST /api/missions/<id>/tokens/<tokenId>/replace` — the creator replaces a
 * machine key in one act; the new secret is in this answer only.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; tokenId: string }> },
): Promise<Response> {
  const { id, tokenId } = await context.params;
  return (await getRoot()).missions.handlers.replaceNamedToken(request, id, tokenId);
}
