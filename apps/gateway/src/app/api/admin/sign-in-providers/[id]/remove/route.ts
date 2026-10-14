/**
 * `POST /api/admin/sign-in-providers/<id>/remove` — removes a sign-in provider
 * saved in Settings; its users' sessions end. Operator only, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return (await getRoot()).auth.handlers.removeSignInProvider(request, id);
}
