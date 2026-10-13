/**
 * `POST /oauth/authorize/decision` — the user's answer to the consent screen
 * (origin-checked, user session): a delegation and its single-use code, or
 * `access_denied`. One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).oauth.handlers.decide(request);
}
