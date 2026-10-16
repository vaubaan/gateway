/**
 * `POST /api/missions/preview` — what a draft would yield: what passes, what
 * exceeds the authority, what cannot resolve. Writes nothing.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).missions.handlers.preview(request);
}
