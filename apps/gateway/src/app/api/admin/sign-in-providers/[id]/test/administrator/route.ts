/**
 * `POST /api/admin/sign-in-providers/<id>/test/administrator` — the identity this session's last test returned becomes an administrator.
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
  return (await getRoot()).auth.handlers.makeAdministratorFromTest(request, id);
}
