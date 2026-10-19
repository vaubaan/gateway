/**
 * `POST /auth/local/<provider>` — the password form of the local accounts: a
 * session, or `/login?error=<code>`. Origin-checked, rate-limited.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return (await getRoot()).auth.handlers.passwordLogin(request, decodeURIComponent(provider));
}
