/**
 * `POST /api/admin/identity-provider` — saves the IdP settings into
 * `instance_config` (client secret sealed). Operator only, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.saveIdpSettings(request);
}
