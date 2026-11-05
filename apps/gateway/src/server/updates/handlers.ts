/**
 * Host-agnostic HTTP handler of Administration › Plugins (`Request → Response`, never
 * `next`).
 *
 *   POST /admin/plugins/check   read the versions feed now ("Check now")
 *
 * Operator only, origin-checked (spec §6). **Not audited**: reading the feed changes
 * nothing on the instance — no setting, no plugin, no account — and an audit entry is
 * for an act that changes something (spec §8). The read is the same GET the daily
 * check makes; while `updates.check` is off it makes none.
 */
import { guardMutation, OPERATOR_REFUSALS, refusalResponse, type GuardDeps } from '../auth/guard';
import type { UpdatesModule } from './index';

/** Administration › Plugins. */
export const PLUGINS_PAGE = '/admin/plugins';
/** Where "Check now" posts. */
export const UPDATES_CHECK_ACTION = '/admin/plugins/check';

const SEE_OTHER = 303;

export interface UpdatesHandlerDeps extends GuardDeps {
  readonly updates: Pick<UpdatesModule, 'refresh'>;
}

export interface UpdatesHandlers {
  checkNow(request: Request): Promise<Response>;
}

export function createUpdatesHandlers(deps: UpdatesHandlerDeps): UpdatesHandlers {
  return {
    async checkNow(request) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      // The page reads the outcome itself: the new report, or the failure that replaced it.
      await deps.updates.refresh();
      return new Response(null, {
        status: SEE_OTHER,
        headers: { Location: PLUGINS_PAGE, 'Cache-Control': 'no-store' },
      });
    },
  };
}
