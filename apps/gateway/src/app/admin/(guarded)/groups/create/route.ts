/**
 * `POST /admin/groups/create` — creates a local group. Operator only; the handler authorizes
 * by itself (the Administration layout does not cover route handlers).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).groups.handlers.create(request);
}
