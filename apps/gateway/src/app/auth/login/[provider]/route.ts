/**
 * `GET /auth/login/<provider>?return_to=` — starts a sign-in with one sign-in
 * provider (redirect to it). One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  return (await getRoot()).auth.handlers.loginStart(request, provider);
}
