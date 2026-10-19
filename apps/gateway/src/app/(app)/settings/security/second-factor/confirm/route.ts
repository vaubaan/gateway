/** `POST /settings/security/second-factor/confirm` — Settings → Security; the handler authorizes by itself (a signed-in user). */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.confirmSecondFactor(request);
}
