/**
 * In-process report queue: bounded, flushed in batches, backing off when the
 * collector does not answer.
 *
 *   push(report)      appended; when the queue is full the OLDEST report is
 *                     dropped (telemetry is best effort, memory is not).
 *   flush             at most one in flight. A batch of up to `batchSize`
 *                     reports is handed to `send`:
 *                       delivered  the batch leaves the queue; the next flush
 *                                  is immediate while a full batch remains,
 *                                  otherwise after `flushIntervalMs`
 *                       retry      the batch stays; the next attempt waits
 *                                  `initialMs * factor^(failures-1)`, capped at
 *                                  `maxMs`, shortened by up to `jitter` of
 *                                  itself so instances do not retry in step
 *                       rejected   the batch is dropped: a payload the
 *                                  collector refuses is never sent twice
 *                     A `send` that throws counts as `retry`.
 *
 * Nothing is persisted: a restart loses what was queued.
 *
 * // single-process only — the queue lives in the memory of one process. A
 * // multi-replica deployment keeps one queue per replica (reports carry no
 * // instance identity, so nothing needs to be shared); a deployment that
 * // wants durable delivery replaces this class behind `ReportBuffer`.
 */
import type { TelemetryReport } from './wire.ts';

export type SendResult = 'delivered' | 'retry' | 'rejected';

/** What the client needs from a buffer; `ReportQueue` is the in-memory one. */
export interface ReportBuffer {
  push(report: TelemetryReport): void;
  clear(): void;
  stop(): void;
}

export interface BackoffOptions {
  /** Delay after the first failure. */
  readonly initialMs: number;
  /** Upper bound of the delay. */
  readonly maxMs: number;
  /** Multiplier per consecutive failure. */
  readonly factor: number;
  /** Share of the delay that may be shaved off at random, 0 to 1. */
  readonly jitter: number;
}

/** The handle `schedule` returns: enough to cancel, and to not hold the process open. */
export interface ScheduledTask {
  cancel(): void;
}

export interface ReportQueueOptions {
  readonly send: (batch: readonly TelemetryReport[]) => Promise<SendResult>;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly maxQueued?: number;
  readonly backoff?: Partial<BackoffOptions>;
  /** Runs `task` after `delayMs`. Default: an unref'd `setTimeout`. */
  readonly schedule?: (task: () => void, delayMs: number) => ScheduledTask;
  /** Source of the jitter, in [0, 1). Default: `Math.random`. */
  readonly random?: () => number;
}

export const QUEUE_DEFAULTS = {
  batchSize: 50,
  flushIntervalMs: 60_000,
  maxQueued: 1_000,
  backoff: { initialMs: 30_000, maxMs: 3_600_000, factor: 2, jitter: 0.2 },
} as const;

export interface QueueStats {
  readonly queued: number;
  readonly delivered: number;
  /** Reports dropped because the queue was full or the collector refused them. */
  readonly dropped: number;
  /** Consecutive failed attempts since the last delivery. */
  readonly failures: number;
}

function defaultSchedule(task: () => void, delayMs: number): ScheduledTask {
  const timer = setTimeout(task, delayMs);
  // A pending flush must never keep the process alive.
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

/** The delay before the attempt that follows `failures` consecutive failures (>= 1). */
export function backoffDelayMs(failures: number, backoff: BackoffOptions, random: number): number {
  const exponent = Math.max(0, failures - 1);
  const base = Math.min(backoff.maxMs, backoff.initialMs * backoff.factor ** exponent);
  const shaved = base * backoff.jitter * Math.min(Math.max(random, 0), 1);
  return Math.round(base - shaved);
}

export class ReportQueue implements ReportBuffer {
  private readonly pending: TelemetryReport[] = [];
  private readonly send: ReportQueueOptions['send'];
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueued: number;
  private readonly backoff: BackoffOptions;
  private readonly schedule: NonNullable<ReportQueueOptions['schedule']>;
  private readonly random: () => number;

  private scheduled: ScheduledTask | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private failures = 0;
  private delivered = 0;
  private dropped = 0;

  constructor(options: ReportQueueOptions) {
    this.send = options.send;
    this.batchSize = positive(options.batchSize, QUEUE_DEFAULTS.batchSize, 'batchSize');
    this.flushIntervalMs = positive(
      options.flushIntervalMs,
      QUEUE_DEFAULTS.flushIntervalMs,
      'flushIntervalMs',
    );
    this.maxQueued = positive(options.maxQueued, QUEUE_DEFAULTS.maxQueued, 'maxQueued');
    this.backoff = { ...QUEUE_DEFAULTS.backoff, ...options.backoff };
    this.schedule = options.schedule ?? defaultSchedule;
    this.random = options.random ?? Math.random;
  }

  get stats(): QueueStats {
    return {
      queued: this.pending.length,
      delivered: this.delivered,
      dropped: this.dropped,
      failures: this.failures,
    };
  }

  push(report: TelemetryReport): void {
    if (this.stopped) return;
    this.pending.push(report);
    while (this.pending.length > this.maxQueued) {
      this.pending.shift();
      this.dropped += 1;
    }
    // While backing off, a full batch does not shorten the wait.
    if (this.failures > 0) this.arm(this.nextBackoffMs());
    else if (this.pending.length >= this.batchSize) this.arm(0, true);
    else this.arm(this.flushIntervalMs);
  }

  /**
   * Sends one batch now (or joins the flush in flight). For shutdown paths
   * and tests; the timer does the same on its own.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || this.pending.length === 0) return Promise.resolve();
    this.disarm();
    const batch = this.pending.slice(0, this.batchSize);
    this.inFlight = this.attempt(batch).finally(() => {
      this.inFlight = null;
      this.rearm();
    });
    return this.inFlight;
  }

  /** Drops everything queued (telemetry switched off: nothing may leave later). */
  clear(): void {
    this.dropped += this.pending.length;
    this.pending.length = 0;
    this.failures = 0;
    this.disarm();
  }

  /** Stops the timer and forgets the queue. The queue accepts nothing afterwards. */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.disarm();
  }

  private async attempt(batch: readonly TelemetryReport[]): Promise<void> {
    let result: SendResult;
    try {
      result = await this.send(batch);
    } catch {
      result = 'retry';
    }
    if (result === 'retry') {
      this.failures += 1;
      return;
    }
    // `clear()` or an overflow may have removed part of the batch meanwhile:
    // whatever of it is still queued is taken off, by identity.
    const sent = new Set(batch);
    const kept = this.pending.filter((report) => !sent.has(report));
    const removed = this.pending.length - kept.length;
    this.pending.length = 0;
    this.pending.push(...kept);
    this.failures = 0;
    if (result === 'delivered') this.delivered += batch.length;
    // A refused batch counts what it removed: `clear()` already counted the rest.
    else this.dropped += removed;
  }

  private rearm(): void {
    if (this.stopped || this.pending.length === 0) return;
    if (this.failures > 0) this.arm(this.nextBackoffMs());
    else if (this.pending.length >= this.batchSize) this.arm(0, true);
    else this.arm(this.flushIntervalMs);
  }

  private nextBackoffMs(): number {
    return backoffDelayMs(this.failures, this.backoff, this.random());
  }

  /** Arms the timer unless one is pending; `replace` swaps a later timer for a sooner one. */
  private arm(delayMs: number, replace = false): void {
    if (this.inFlight) return; // `rearm` runs when the flush settles
    if (this.scheduled) {
      if (!replace) return;
      this.disarm();
    }
    this.scheduled = this.schedule(() => {
      this.scheduled = null;
      void this.flush();
    }, delayMs);
  }

  private disarm(): void {
    this.scheduled?.cancel();
    this.scheduled = null;
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ReportQueue: ${name} must be an integer >= 1`);
  }
  return value;
}
