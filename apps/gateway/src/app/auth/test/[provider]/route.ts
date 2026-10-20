/**
 * `GET /auth/test/<provider>` — tests a sign-in provider beside the session, in
 * another window: the provider's flow runs to its end, and its callback signs
 * nobody in (ADR administrators-live-in-the-instance). Operator only.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  return (await getRoot()).auth.handlers.testStart(request, provider);
}
