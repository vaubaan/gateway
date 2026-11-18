/**
 * `POST /admin/plugins/signers/add` — Administration › Plugins: trusts a company key for private plugins, named; the name typed again; every administrator is notified (ADR
 * plugin-signature-sets-the-trust-level). Operator only; the handler authorizes by itself and
 * audits. One-line adapter over the host-agnostic handler (`server/plugins/handlers.ts`).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).pluginInstall.handlers.addSigner(request);
}
