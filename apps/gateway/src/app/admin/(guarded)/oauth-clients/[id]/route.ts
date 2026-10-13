/**
 * `POST /admin/oauth-clients/<id>` — the operator approves or disables an
 * OAuth client of the management door. Operator only, origin-checked. One-line
 * adapter over the host-agnostic handler; the Administration layout guard does
 * not cover route handlers, so the handler authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).oauth.handlers.decideClient(request, (await params).id);
}
