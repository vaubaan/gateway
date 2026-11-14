/**
 * `GET /connections/callback/<provider>` — where the provider sends the
 * browser back (the OAuth redirect URI). The
 * single-use `state` of the query string names the pending flow. One-line
 * adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return (await getRoot()).accounts.handlers.callback(request, (await params).provider);
}
