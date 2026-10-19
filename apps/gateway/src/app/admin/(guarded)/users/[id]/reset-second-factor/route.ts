/** `POST /admin/users/<id>/reset-second-factor` — an administrator resets a person's second factor. Operator only. */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).users.handlers.resetSecondFactor(request, (await params).id);
}
