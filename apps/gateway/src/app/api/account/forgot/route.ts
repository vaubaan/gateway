/** `POST /api/account/forgot` — an address; one answer whatever it is. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.forgotPassword(request);
}
