/**
 * `POST /auth/test/<sign-in provider>` — tests a sign-in provider beside the session, in
 * another window: the sign-in provider's flow runs to its end, and its callback signs
 * nobody in (ADR administrators-live-in-the-instance). Operator only, origin-checked.
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ signInProvider: string }> },
): Promise<Response> {
  const { signInProvider } = await params;
  return (await getRoot()).auth.handlers.testStart(request, signInProvider);
}
