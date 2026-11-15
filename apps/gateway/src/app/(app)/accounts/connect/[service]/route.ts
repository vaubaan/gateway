/**
 * `POST /accounts/connect/<service>` — starts a connect flow (redirect to
 * the service for `oauth2`) or submits its form (`api-key`, `ssh-key`). One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ service: string }> },
): Promise<Response> {
  return (await getRoot()).accounts.handlers.connect(request, (await params).service);
}
