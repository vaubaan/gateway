/**
 * `GET /r/<id>` — the URL a `budget-exhausted` or `approval-required` refusal
 * carries (spec §3.4). Per-IP rate limit, bearer refused, sign-in when there
 * is no session, 403 for anyone but the mission's creator, and for the
 * creator a redirect to the request in the inbox (`/requests/<id>`).
 * The path prefix is `REQUEST_PATH_PREFIX` of `@/server/requests`.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).requests.handlers.open(request, id);
}
