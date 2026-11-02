/**
 * `POST /api/notifications/devices/<id>/rename` — renames one of my devices (the Settings
 * form). Keyed by the signed-in person: another's device reads as missing. Origin-checked.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return (await getRoot()).notifications.handlers.rename(request, id);
}
