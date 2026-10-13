import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  QUEUE_DEFAULTS,
  ReportQueue,
  type ScheduledTask,
  type SendResult,
} from './queue.ts';
import { createPluginReport, type PluginReport } from './report.ts';

function report(n: number): PluginReport {
  const built = createPluginReport({
    plugin: 'depot',
    plugin_version: '1.0.0',
    gateway_version: 'dev',
    tool: `depot__tool_${n}`,
    outcome: 'success',
    error_class: null,
  });
  if (!built) throw new Error('fixture report refused');
  return built;
}

/** A scheduler the test fires by hand, recording every delay asked for. */
function manualScheduler() {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  return {
    delays,
    schedule(task: () => void, delayMs: number): ScheduledTask {
      delays.push(delayMs);
      pending = task;
      return {
        cancel: () => {
          if (pending === task) pending = null;
        },
      };
    },
    get armed(): boolean {
      return pending !== null;
    },
    /** Runs the pending task and waits for the flush it starts. */
    async fire(queue: ReportQueue): Promise<void> {
      const task = pending;
      pending = null;
      task?.();
      await queue.flush();
    },
  };
}

function rig(
  results: SendResult[] | ((batch: readonly PluginReport[]) => Promise<SendResult>),
  options: { batchSize?: number; maxQueued?: number } = {},
) {
  const batches: PluginReport[][] = [];
  const scheduler = manualScheduler();
  const queue = new ReportQueue({
    send: async (batch) => {
      batches.push([...batch]);
      if (typeof results === 'function') return results(batch);
      return results.shift() ?? 'delivered';
    },
    batchSize: options.batchSize ?? 3,
    maxQueued: options.maxQueued ?? 10,
    flushIntervalMs: 1_000,
    backoff: { initialMs: 100, maxMs: 1_000, factor: 2, jitter: 0 },
    schedule: scheduler.schedule,
    random: () => 0,
  });
  return { queue, batches, scheduler };
}

describe('ReportQueue: batching', () => {
  it('waits for the flush interval while a batch is not full, then sends what is queued', async () => {
    const { queue, batches, scheduler } = rig([]);
    queue.push(report(1));
    queue.push(report(2));
    expect(batches).toHaveLength(0);
    expect(scheduler.delays).toEqual([1_000]); // one timer for both pushes

    await scheduler.fire(queue);
    expect(batches).toEqual([[report(1), report(2)]]);
    expect(queue.stats).toMatchObject({ queued: 0, delivered: 2, dropped: 0, failures: 0 });
    expect(scheduler.armed).toBe(false);
  });

  it('flushes at once when a batch is full, and sends at most batchSize reports per request', async () => {
    const { queue, batches, scheduler } = rig([]);
    for (let n = 1; n <= 7; n += 1) queue.push(report(n));
    // The interval timer was replaced by an immediate one when the third report arrived.
    expect(scheduler.delays.slice(0, 2)).toEqual([1_000, 0]);

    await scheduler.fire(queue);
    expect(batches[0]).toHaveLength(3);
    // A full batch remains: the next flush is immediate too.
    expect(scheduler.delays.at(-1)).toBe(0);
    await scheduler.fire(queue);
    expect(batches[1]).toHaveLength(3);
    // One report left: back to the interval.
    expect(scheduler.delays.at(-1)).toBe(1_000);
    await scheduler.fire(queue);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(batches.flat()).toEqual([1, 2, 3, 4, 5, 6, 7].map(report));
    expect(queue.stats.delivered).toBe(7);
  });

  it('never runs two sends at the same time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const { queue } = rig(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      inFlight -= 1;
      return 'delivered';
    });
    queue.push(report(1));
    const first = queue.flush();
    const second = queue.flush();
    expect(second).toBe(first);
    queue.push(report(2));
    release!();
    await first;
    expect(maxInFlight).toBe(1);
  });

  it('drops the oldest reports when the queue is full', async () => {
    const { queue, batches, scheduler } = rig([], { batchSize: 10, maxQueued: 4 });
    for (let n = 1; n <= 6; n += 1) queue.push(report(n));
    expect(queue.stats).toMatchObject({ queued: 4, dropped: 2 });
    await scheduler.fire(queue);
    expect(batches[0]).toEqual([3, 4, 5, 6].map(report));
  });
});

describe('ReportQueue: backoff', () => {
  it('keeps a batch the collector did not take and retries it with a growing, capped delay', async () => {
    const { queue, batches, scheduler } = rig(['retry', 'retry', 'retry', 'retry', 'retry']);
    queue.push(report(1));
    for (let attempt = 0; attempt < 5; attempt += 1) await scheduler.fire(queue);

    // interval, then 100, 200, 400, 800, 1000 (capped).
    expect(scheduler.delays).toEqual([1_000, 100, 200, 400, 800, 1_000]);
    expect(batches).toHaveLength(5);
    expect(batches.every((b) => b.length === 1 && b[0] === batches[0]?.[0])).toBe(true);
    expect(queue.stats).toMatchObject({ queued: 1, delivered: 0, failures: 5 });

    // The collector is back: the same batch is delivered and the backoff is forgotten.
    await scheduler.fire(queue);
    expect(queue.stats).toMatchObject({ queued: 0, delivered: 1, failures: 0 });
    queue.push(report(2));
    expect(scheduler.delays.at(-1)).toBe(1_000);
  });

  it('does not let a full batch shorten the wait while backing off', async () => {
    const { queue, scheduler } = rig(['retry']);
    queue.push(report(1));
    await scheduler.fire(queue);
    expect(scheduler.delays.at(-1)).toBe(100);
    const armedBefore = scheduler.delays.length;
    for (let n = 2; n <= 6; n += 1) queue.push(report(n));
    expect(scheduler.delays).toHaveLength(armedBefore); // still the one backoff timer
  });

  it('treats a send that throws as a retry', async () => {
    let calls = 0;
    const { queue, scheduler } = rig(async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return 'delivered';
    });
    queue.push(report(1));
    await scheduler.fire(queue);
    expect(queue.stats).toMatchObject({ queued: 1, failures: 1 });
    await scheduler.fire(queue);
    expect(queue.stats).toMatchObject({ queued: 0, delivered: 1 });
  });

  it('drops a batch the collector refuses instead of sending it again', async () => {
    const { queue, batches, scheduler } = rig(['rejected']);
    queue.push(report(1));
    queue.push(report(2));
    await scheduler.fire(queue);
    expect(batches).toHaveLength(1);
    expect(queue.stats).toMatchObject({ queued: 0, delivered: 0, dropped: 2, failures: 0 });
    expect(scheduler.armed).toBe(false);
  });

  it('computes the delay from the failure count, the cap and the jitter', () => {
    const backoff = { initialMs: 30_000, maxMs: 3_600_000, factor: 2, jitter: 0.2 };
    expect(backoffDelayMs(1, backoff, 0)).toBe(30_000);
    expect(backoffDelayMs(2, backoff, 0)).toBe(60_000);
    expect(backoffDelayMs(4, backoff, 0)).toBe(240_000);
    expect(backoffDelayMs(40, backoff, 0)).toBe(3_600_000);
    // Jitter only ever shortens, by at most its share.
    expect(backoffDelayMs(1, backoff, 1)).toBe(24_000);
    expect(backoffDelayMs(1, backoff, 0.5)).toBe(27_000);
    expect(QUEUE_DEFAULTS.backoff).toEqual(backoff);
  });
});

describe('ReportQueue: clear and stop', () => {
  it('clear() empties the queue and cancels the timer', async () => {
    const { queue, batches, scheduler } = rig([]);
    queue.push(report(1));
    queue.clear();
    expect(scheduler.armed).toBe(false);
    await queue.flush();
    expect(batches).toHaveLength(0);
    expect(queue.stats).toMatchObject({ queued: 0, dropped: 1 });
  });

  it('stop() cancels the timer and accepts nothing afterwards', async () => {
    const { queue, batches, scheduler } = rig([]);
    queue.push(report(1));
    queue.stop();
    expect(scheduler.armed).toBe(false);
    queue.push(report(2));
    await queue.flush();
    expect(batches).toHaveLength(0);
    expect(queue.stats.queued).toBe(0);
  });

  it('refuses nonsensical sizes', () => {
    expect(() => new ReportQueue({ send: async () => 'delivered', batchSize: 0 })).toThrow(
      /batchSize/,
    );
  });
});
