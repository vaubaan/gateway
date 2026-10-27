/**
 * `POST /connections/<id>/default-env` — the owner's default environment label
 * for the account's unlabelled resources (ADR connect-driver-and-resource-curation).
 * One-line adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return (await getRoot()).connections.handlers.setDefaultEnv(request, (await params).id);
}
