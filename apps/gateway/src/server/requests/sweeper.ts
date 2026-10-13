/**
 * Expiry sweeper of the request inbox (spec §2.3: a request left unanswered
 * for the configured delay becomes `expired`; plan §3.6: "runs in-process on
 * an interval; it only flips `open → expired` and erases argument blobs").
 *
 * The delay itself is the configuration's (`requests.expiry`, default 24 h):
 * the budget stamps `expires_at` when it drops the request. This timer only
 * makes the stored state catch up; every reader already treats an overdue
 * open request as expired (`effectiveState`), so a late tick delays nothing
 * a human or an agent can observe.
 *
 * The flip is one idempotent conditional `UPDATE` per request, so several
 * replicas of a hosted deployment may each run their own sweeper against a
 * shared store without coordination. The timer handle is per process by
 * nature and needs no shared replacement.
 */
import type { Logger } from '../logging';

/** How often the stored state catches up with the clock. */
export const REQUEST_SWEEP_INTERVAL_MS = 60_000;

export interface RequestSweeperDeps {
  /** `RequestService.sweep`. */
  readonly sweep: () => Promise<number>;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface RequestSweeper {
  /** One pass now; resolves with the number of requests expired. Never rejects. */
  runOnce(): Promise<number>;
  stop(): void;
}

export function startRequestSweeper(deps: RequestSweeperDeps): RequestSweeper {
  let running = false;

  async function runOnce(): Promise<number> {
    // A pass slower than the interval is not stacked on.
    if (running) return 0;
    running = true;
    try {
      return await deps.sweep();
    } catch (err) {
      deps.logger.error('request sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void runOnce(), deps.intervalMs ?? REQUEST_SWEEP_INTERVAL_MS);
  // The sweeper never keeps the process alive on its own.
  timer.unref();

  return {
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}
