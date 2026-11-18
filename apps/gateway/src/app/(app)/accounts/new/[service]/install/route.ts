/**
 * `POST /accounts/new/<service>/install` — the first connection of a service the instance
 * has no plugin for: the catalog's version is installed and loaded, then the connection page
 * follows (ADR plugins-installed-when-first-needed). Any signed-in person; the handler
 * authorizes by itself and audits. One-line adapter over `server/plugins/handlers.ts`.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ service: string }> },
): Promise<Response> {
  const { service } = await params;
  return (await getRoot()).pluginInstall.handlers.installForConnection(request, service);
}
