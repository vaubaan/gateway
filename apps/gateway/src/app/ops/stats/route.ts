/**
 * `GET /ops/stats` — thin Next adapter over the host-agnostic handler
 * (`server/http/ops-stats.ts`; spec §4.3 bis). In setup mode (no root yet) the
 * token of the configuration still gates, then the answer is 503 `setup`.
 */
import { getRoot, type GatewayRoot } from '@/server/compose';
import {
  opsStatsResponse,
  opsStatsSetupResponse,
  opsStatsUnavailableResponse,
} from '@/server/http';
import { currentSetup } from '@/server/setup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const setup = currentSetup();
  if (setup) return opsStatsSetupResponse(request, setup.config.ops.token);
  let root: GatewayRoot;
  try {
    root = await getRoot();
  } catch {
    return opsStatsUnavailableResponse();
  }
  return opsStatsResponse(request, root.opsStats);
}
