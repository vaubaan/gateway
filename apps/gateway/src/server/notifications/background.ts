/**
 * Work started after a response, never awaited by it: at most `concurrency` tasks run at
 * once, the others wait in order; a task that throws is logged and forgotten. Nothing is
 * retried. `idle()` resolves once nothing runs or waits (tests, and `stop()`); `stop()`
 * waits for what was started, the deliveries it queues included, then refuses new work, so
 * the store closes after the last delivery wrote its outcome.
 *
 * single-process only: the queue is in memory. A task lost to a restart is a notification
 * lost, which best effort allows (spec §4.2 bis "Delivery is best effort").
 */
import type { Logger } from '../logging';

export interface BackgroundRunner {
  run(name: string, task: () => Promise<void>): void;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/** How many deliveries leave at once: enough for a burst, never a flood of sockets. */
export const DEFAULT_CONCURRENCY = 4;
/** Beyond this many waiting, new work is dropped (and logged): memory stays bounded. */
export const DEFAULT_MAX_WAITING = 1000;

export function createBackgroundRunner(
  logger: Logger,
  options: { readonly concurrency?: number; readonly maxWaiting?: number } = {},
): BackgroundRunner {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxWaiting = options.maxWaiting ?? DEFAULT_MAX_WAITING;
  const waiting: Array<{ readonly name: string; readonly task: () => Promise<void> }> = [];
  let running = 0;
  let stopped = false;
  let idleWaiters: Array<() => void> = [];

  const settleIfIdle = (): void => {
    if (running > 0 || waiting.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const pump = (): void => {
    while (running < concurrency) {
      const next = waiting.shift();
      if (!next) break;
      running += 1;
      void next
        .task()
        .catch((err: unknown) => {
          logger.warn('notification work failed', {
            work: next.name,
            error_class: err instanceof Error ? err.name : typeof err,
          });
        })
        .finally(() => {
          running -= 1;
          pump();
          settleIfIdle();
        });
    }
  };

  const idle = (): Promise<void> => {
    if (running === 0 && waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  };

  return {
    run(name, task) {
      if (stopped) {
        logger.warn('notification dropped: the instance is stopping', { work: name });
        return;
      }
      if (waiting.length >= maxWaiting) {
        logger.warn('notification dropped: too much waiting', { work: name });
        return;
      }
      waiting.push({ name, task });
      // Never in the caller's turn: the response leaves first.
      setImmediate(pump);
    },
    idle,
    async stop() {
      // What runs may still queue its deliveries: wait for all of it, then refuse.
      await idle();
      stopped = true;
    },
  };
}
