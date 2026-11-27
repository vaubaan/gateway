/**
 * `POST /auth/loopback/status` — the window that started a flow of an installed-app
 * client polls it: `pending`, `none`, or `done` with where to go (the session's cookie set).
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).auth.handlers.loopbackStatus(request);
}
