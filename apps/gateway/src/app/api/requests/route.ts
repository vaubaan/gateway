/**
 * `GET /api/requests` — the open requests awaiting the signed-in user as
 * creator. Human session only: a bearer is refused.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).requests.handlers.inbox(request);
}
