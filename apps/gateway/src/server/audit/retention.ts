/**
 * Audit retention sweeper (spec §6 "Purge by operator-configured retention",
 * §8 "Retention configured by the operator, 90 days by default").
 *
 * Deletes audit entries older than `retention_days` through the store's only
 * delete path (`AuditRepo.purgeByRetention`): once when the instance boots,
 * then every `intervalMs`. The purge is idempotent and bounded by its cutoff,
 * so a sweep that runs twice, or late, removes the same rows.
 *
 * The same sweep removes the mission log history of the same age — the timeline
 * events and the counters of periods that are over (`MissionLogRetention`,
 * `budget/retention.ts`): `retention_days` is one promise about how long a call
 * is remembered, wherever it is written. The two purges fail apart: one that
 * throws is logged and does not hold the other back.
 */
import type { MissionLogRetention } from '../budget/retention';
import type { Logger } from '../logging';
import type { AuditRepo } from '../store';

export const RETENTION_SWEEP_INTERVAL_MS = 3_600_000;

/** What the sweeper needs of a timer; the defaults are the process timers. */
export interface SweepTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RetentionSweeperDeps {
  readonly audit: Pick<AuditRepo, 'purgeByRetention'>;
  /** The mission log history of the same age; absent, only the audit is swept. */
  readonly missionLogHistory?: Pick<MissionLogRetention, 'purge'>;
  /** `InstanceConfig.retentionDays` (`retention_days` / `VAUBAAN_RETENTION_DAYS`). */
  readonly retentionDays: number;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly timers?: SweepTimers;
}

const processTimers: SweepTimers = {
  setInterval(fn, ms) {
    const handle: unknown = setInterval(fn, ms);
    // A pending sweep never keeps the process alive.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as Parameters<typeof clearInterval>[0]);
  },
};

export class AuditRetentionSweeper {
  // single-process only — the timer lives in this process. Replaced in a
  // hosted deployment by one scheduled job calling `sweep()` (the same
  // `AuditRepo.purgeByRetention`); several replicas sweeping at once would be
  // wasteful, not wrong.
  private handle: unknown = null;
  private running: Promise<number | null> | null = null;

  constructor(private readonly deps: RetentionSweeperDeps) {}

  get started(): boolean {
    return this.handle !== null;
  }

  /** Sweeps once, then on every interval. Resolves after the first sweep. Idempotent. */
  async start(): Promise<void> {
    if (this.handle !== null) return;
    const timers = this.deps.timers ?? processTimers;
    this.handle = timers.setInterval(() => {
      void this.sweep();
    }, this.deps.intervalMs ?? RETENTION_SWEEP_INTERVAL_MS);
    await this.sweep();
  }

  /** Stops the timer and waits for a sweep in flight, so the store can close. */
  async stop(): Promise<void> {
    if (this.handle !== null) {
      (this.deps.timers ?? processTimers).clearInterval(this.handle);
      this.handle = null;
    }
    await this.running;
  }

  /**
   * One purge. Returns the number of audit entries removed, or `null` when
   * that purge failed: a failure is logged and the next interval retries, it
   * never takes the instance down. The mission log history is purged in the same
   * sweep; what it removed is in the log.
   */
  sweep(): Promise<number | null> {
    this.running ??= this.purge().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async purge(): Promise<number | null> {
    const removed = await this.purgeAudit();
    await this.purgeMissionLogHistory();
    return removed;
  }

  private async purgeMissionLogHistory(): Promise<void> {
    const { missionLogHistory, retentionDays, logger } = this.deps;
    if (!missionLogHistory) return;
    try {
      const removed = await missionLogHistory.purge(retentionDays);
      if (removed.events > 0 || removed.counters > 0) {
        logger.info('audit retention: mission log history purged', {
          events: removed.events,
          counters: removed.counters,
          retention_days: retentionDays,
        });
      }
    } catch (err) {
      logger.error('audit retention: mission log history purge failed', {
        retention_days: retentionDays,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async purgeAudit(): Promise<number | null> {
    const { audit, retentionDays, logger } = this.deps;
    try {
      const removed = await audit.purgeByRetention(retentionDays);
      if (removed > 0) {
        logger.info('audit retention: entries purged', {
          removed,
          retention_days: retentionDays,
        });
      }
      return removed;
    } catch (err) {
      logger.error('audit retention: purge failed', {
        retention_days: retentionDays,
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
