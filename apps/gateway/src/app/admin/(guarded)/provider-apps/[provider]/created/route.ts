/**
 * `GET /admin/provider-apps/<provider>/created` — where the provider sends the
 * browser back once the administrator confirmed the app (the manifest's
 * `redirect_url`). The state is taken once, in the session that started the
 * flow; the code is exchanged server to server; the outcome comes back to the
 * Company apps page as a one-time notice. The handler authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return (await getRoot()).connections.handlers.completeAppRegistration(
    request,
    (await params).provider,
  );
}
