/**
 * `POST /api/recover/proof` — the browser's proof that it holds the master key; a recovery session on success (ADR administrators-live-in-the-instance §9).
 * No session; origin-checked, rate-limited. One-line adapter.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.recoverProof(request);
}
