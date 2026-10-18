/**
 * `POST /api/setup/master-key` — setup mode only: the setup page hands the
 * instance the key file of the copy to restore (bootstrap token + file).
 * Outside setup mode there is nothing to receive: 404.
 */
import { createSetupHandlers, currentSetup } from '@/server/setup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const setup = currentSetup();
  if (!setup) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return createSetupHandlers(setup).receiveKey(request);
}
