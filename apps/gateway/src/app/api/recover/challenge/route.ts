/**
 * `POST /api/recover/challenge` — a challenge for the recovery by the master key, bound to this browser (ADR administrators-live-in-the-instance §9).
 * No session; origin-checked, rate-limited. One-line adapter.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.recoverChallenge(request);
}
