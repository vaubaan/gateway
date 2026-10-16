/**
 * `POST /logout/everywhere` — the signed-in person ends every one of their web
 * sessions, this one included (origin-checked). GET is not offered: a sign-out
 * is a mutation.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.signOutEverywhere(request);
}
