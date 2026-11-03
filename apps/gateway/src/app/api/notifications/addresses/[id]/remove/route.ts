/**
 * `POST /api/notifications/addresses/<id>/remove` — removes one of my messaging addresses
 * (the Settings form, asked first). Keyed by the signed-in person: another's address reads
 * as missing. Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).notifications.handlers.removeAddress(request, id);
}
