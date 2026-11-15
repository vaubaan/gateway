/** `POST /auth/local/<sign-in provider>/enrol` — the first code of the authenticator an administrator enrols at sign-in. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ signInProvider: string }> },
): Promise<Response> {
  const { signInProvider } = await context.params;
  return (await getRoot()).auth.handlers.enrolAtSignIn(request, decodeURIComponent(signInProvider));
}
