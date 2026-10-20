/**
 * `POST /api/admin/sign-in-providers/<id>/disable` — switches a sign-in provider off; its users' sessions end, never the last way in.
 * Operator only, origin-checked (ADR administrators-live-in-the-instance).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return (await getRoot()).auth.handlers.disableSignInProvider(request, id);
}
