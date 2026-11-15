/**
 * `POST /api/accounts/refresh` — a page that shows accounts asks to refresh the stale
 * ones, `{ account_ids }`; only those the person may use, origin-checked. Answers
 * `{ refreshed, changed }` (handbook accounts, "Accounts refresh themselves").
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).accounts.handlers.refreshOnOpen(request);
}
