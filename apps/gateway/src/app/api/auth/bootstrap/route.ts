/**
 * `POST /api/auth/bootstrap` — operator sign-in with the bootstrap token
 * (form field `token`); origin-checked; refused once the token is revoked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.bootstrapLogin(request);
}
