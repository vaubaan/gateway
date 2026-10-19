/** `POST /api/account/create` — an invitation link's token and a password: the account, signed in. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.createAccount(request);
}
