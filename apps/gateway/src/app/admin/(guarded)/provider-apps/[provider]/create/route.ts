/**
 * `POST /admin/provider-apps/<provider>/create` — starts creating the company
 * app through the provider's manifest flow: checks the administrator's choice,
 * draws the single-use state, and sends the browser to the page that posts the
 * manifest to the provider. Operator only, origin-checked; the handler
 * authorizes by itself (the layout guard does not cover route handlers).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return (await getRoot()).connections.handlers.startAppRegistration(
    request,
    (await params).provider,
  );
}
