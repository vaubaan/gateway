/**
 * `POST /accounts/<id>/revoke` — revokes the account (terminal).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).accounts.handlers.revoke(request, (await params).id);
}
