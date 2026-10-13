/**
 * `POST /api/missions/<id>/tokens/<tokenId>/revoke` — its holder, or the creator, revokes
 * one token; the others keep working. Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; tokenId: string }> },
): Promise<Response> {
  const { id, tokenId } = await context.params;
  return (await getRoot()).missions.handlers.revokeToken(request, id, tokenId);
}
