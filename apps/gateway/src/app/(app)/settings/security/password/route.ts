/** `POST /settings/security/password` — Settings → Security; the handler authorizes by itself (a signed-in user). */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.changePassword(request);
}
