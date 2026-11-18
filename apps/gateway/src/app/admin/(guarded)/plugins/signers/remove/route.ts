/**
 * `POST /admin/plugins/signers/remove` — Administration › Plugins: no longer trusts a key; a version it signed is refused from the next start (ADR
 * plugin-signature-sets-the-trust-level). Operator only; the handler authorizes by itself and
 * audits. One-line adapter over the host-agnostic handler (`server/plugins/handlers.ts`).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).pluginInstall.handlers.removeSigner(request);
}
