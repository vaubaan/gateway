/**
 * `POST /logout` — destroys the web session (origin-checked). GET is not
 * offered: a sign-out is a mutation.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.logout(request);
}
