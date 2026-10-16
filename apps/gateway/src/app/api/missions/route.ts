/**
 * `POST /api/missions` — issues a mission from a draft; the token secret is
 * in this response only. User session, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).missions.handlers.issue(request);
}
