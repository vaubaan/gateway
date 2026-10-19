/** `POST /auth/local/<provider>/code` — the second factor of a local sign-in: a code, or a recovery code. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return (await getRoot()).auth.handlers.secondFactorLogin(request, decodeURIComponent(provider));
}
