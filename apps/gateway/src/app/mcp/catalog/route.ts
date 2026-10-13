/**
 * `GET /mcp/catalog` — the mission's catalog: tools, resources, remaining
 * budget (spec §4.1 "Catalog"). Thin Next adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return (await getRoot()).execution.handlers.catalog(request);
}
