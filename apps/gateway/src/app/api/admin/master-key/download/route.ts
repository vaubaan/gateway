/**
 * `POST /api/admin/master-key/download` — the master key file, as an
 * attachment, to an operator signed in recently; audited before it leaves.
 * Origin-checked; the handler authorizes by itself.
 */
import { getRoot } from '@/server/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return (await getRoot()).masterKey.handlers.download(request);
}
