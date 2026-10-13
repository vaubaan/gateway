/**
 * `POST /settings/connected-apps/<id>/revoke` — a person disconnects one of the
 * apps they connected (ends one of their delegations).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).oauth.handlers.revokeDelegation(request, (await params).id);
}
