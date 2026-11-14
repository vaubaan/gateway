/**
 * `POST /accounts/<id>/shares` — shares the account to a user or a group, or
 * replaces the restriction that target already holds.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).shares.handlers.share(request, (await params).id);
}
