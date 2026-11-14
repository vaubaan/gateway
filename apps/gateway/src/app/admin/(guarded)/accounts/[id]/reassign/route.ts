/**
 * `POST /admin/accounts/<id>/reassign` — gives an account that has no owner left a new
 * owner (spec §2.3: the operator's only act on the domain). Operator only; the handler
 * authorizes by itself.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).accounts.handlers.reassign(request, (await params).id);
}
