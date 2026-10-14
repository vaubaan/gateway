/**
 * `POST /api/admin/sign-in-providers` — saves a sign-in provider of Settings →
 * Sign-in (client secret sealed, never echoed). Operator only, origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.saveIdpSettings(request);
}
