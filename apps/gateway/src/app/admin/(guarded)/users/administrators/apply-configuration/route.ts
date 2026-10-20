/**
 * `POST /admin/users/administrators/apply-configuration` — applies the configuration's admin rule, in the administrator's name.
 * Operator only; the handler authorizes by itself (ADR administrators-live-in-the-instance).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).users.handlers.applyConfigurationRule(request);
}
