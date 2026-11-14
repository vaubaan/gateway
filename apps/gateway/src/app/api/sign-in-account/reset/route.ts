/** `POST /api/sign-in-account/reset` — a reset link's token and a new password. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.resetPassword(request);
}
