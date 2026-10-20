/**
 * `POST /api/admin/sign-in-providers/<id>/waiver` — waives the gateway's second
 * factor for a provider's people (`always`, `amr`), or asks it again (`none`); never
 * for administrators. Operator only, origin-checked (ADR
 * administrators-live-in-the-instance, §7).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return (await getRoot()).auth.handlers.setSecondFactorWaiver(request, id);
}
