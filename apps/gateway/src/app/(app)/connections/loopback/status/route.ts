/**
 * `POST /connections/loopback/status` — the window that started a connect through
 * Vaubaan's installed client polls it with the person's session.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).accounts.handlers.loopbackConnectStatus(request);
}
