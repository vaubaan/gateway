/**
 * `POST /api/recover/password` — in a recovery session, a new password for a sign-in
 * account, then signed in as it (ADR administrators-live-in-the-instance, amendment
 * 2026-11-26). No web session; origin-checked. One-line adapter.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.recoverPassword(request);
}
