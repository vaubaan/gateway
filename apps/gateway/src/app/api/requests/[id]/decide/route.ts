/**
 * `POST /api/requests/<id>/decide` — the creator's answer to a request.
 * Origin-checked, human session only, creator only.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).requests.handlers.decide(request, id);
}
