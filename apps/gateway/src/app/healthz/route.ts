/**
 * `GET /healthz` — thin Next adapter over the host-agnostic handler. In setup
 * mode (no root yet: the instance waits for its master key) it answers 200
 * with `status: 'setup'`, so the container stays up.
 */
import { getRoot } from '@/server/compose';
import { healthHandler, setupResponse } from '@/server/http';
import { currentSetup } from '@/server/setup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ready = healthHandler(() => getRoot());

export async function GET(): Promise<Response> {
  const setup = currentSetup();
  if (setup) return setupResponse({ build: setup.build, startedAt: setup.startedAt });
  return ready();
}
