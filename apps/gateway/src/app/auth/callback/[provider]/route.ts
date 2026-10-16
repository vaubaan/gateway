/**
 * `GET /auth/callback/<provider>` — the callback registered at a sign-in provider
 * (`<public_url>/auth/callback/<id>`). The handler rebuilds the callback URL from
 * `public_url`; only the query string of this request is used, and an attempt
 * started with another provider is refused.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  return (await getRoot()).auth.handlers.loginCallback(request, provider);
}
