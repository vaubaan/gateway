/**
 * `POST /auth/factor/code` — the second factor of a sign-in through any sign-in provider: a code, or a recovery code (ADR administrators-live-in-the-instance, §7).
 * The step cookie names the person and the sign-in provider. One-line adapter.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.secondFactorLogin(request);
}
