/**
 * `POST /api/admin/sign-in-providers/<id>/enable` — switches a sign-in provider on, after a passed test.
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
  return (await getRoot()).auth.handlers.enableSignInProvider(request, id);
}
