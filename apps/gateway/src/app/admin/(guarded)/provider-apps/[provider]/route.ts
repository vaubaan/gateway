/**
 * `POST /admin/provider-apps/<provider>` — saves (or clears) the OAuth client
 * of one provider into `instance_config`, secrets sealed; the form is on the
 * provider's connect page. Operator only,
 * origin-checked. One-line adapter over the host-agnostic handler; the
 * Administration layout guard does not cover route handlers, so the handler
 * authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return (await getRoot()).connections.handlers.saveProviderApp(request, (await params).provider);
}
