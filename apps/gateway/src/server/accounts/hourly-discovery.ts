/**
 * The hourly discovery (ADR resource-set-is-one-environment-with-optional-future-resources):
 * a timer in the server that, every `intervalMs` (one hour), runs the discovery of each
 * account a running mission's set with future on depends on
 * (`MissionsRepo.accountsWithFutureSets`), one account after the other, so that a
 * resource created elsewhere joins those sets without anyone asking.
 *
 * Single-process: a run never overlaps another (the next one is armed when a run ends,
 * and `runOnce` hands back the run in progress); a second process would run its own
 * schedule. A failed discovery is recorded on the account by the service and logged
 * here by account only — never the provider's words (handbook accounts). The
 * first run waits one interval after the start: a restart does not hit every provider.
 */
import type { Logger } from '../logging';
import type { MissionsRepo } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { AccountService } from './service';

export const HOURLY_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

export interface DiscoveryTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: DiscoveryTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface HourlyDiscoveryDeps {
  readonly missions: Pick<MissionsRepo, 'accountsWithFutureSets'>;
  readonly service: Pick<AccountService, 'discoverOnSchedule'>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly timers?: DiscoveryTimers;
  /** Tests: another interval. */
  readonly intervalMs?: number;
}

/** What one run did. */
export interface HourlyDiscoveryRun {
  /** The accounts it looked at, in order. */
  readonly accounts: readonly string[];
  /** The ones whose discovery failed (recorded on the account). */
  readonly failed: readonly string[];
}

export class HourlyDiscovery {
  private readonly timers: DiscoveryTimers;
  private readonly intervalMs: number;
  private timer: unknown = null;
  private running: Promise<HourlyDiscoveryRun> | null = null;
  private stopped = false;

  constructor(private readonly deps: HourlyDiscoveryDeps) {
    this.timers = deps.timers ?? NODE_TIMERS;
    this.intervalMs = deps.intervalMs ?? HOURLY_DISCOVERY_INTERVAL_MS;
  }

  /** Arms the timer; the first run comes one interval later. */
  start(): void {
    this.stopped = false;
    this.arm();
  }

  /** Disarms the timer and waits for a run in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One run now, or the run already in progress. Never throws. */
  runOnce(): Promise<HourlyDiscoveryRun> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.arm());
    }, this.intervalMs);
  }

  private async run(): Promise<HourlyDiscoveryRun> {
    const looked: string[] = [];
    const failed: string[] = [];
    let accounts: string[];
    try {
      accounts = await this.deps.missions.accountsWithFutureSets(toIso(this.deps.clock.now()));
    } catch (error) {
      this.deps.logger.warn('hourly discovery could not list its accounts', {
        error_class: error instanceof Error ? error.name : typeof error,
      });
      return { accounts: [], failed: [] };
    }
    for (const accountId of accounts) {
      if (this.stopped) break;
      looked.push(accountId);
      try {
        const record = await this.deps.service.discoverOnSchedule(accountId);
        if (record && !record.ok) failed.push(accountId);
      } catch (error) {
        failed.push(accountId);
        this.deps.logger.warn('hourly discovery failed', {
          account_id: accountId,
          error_class: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    this.deps.logger.info('hourly discovery ran', {
      accounts: looked.length,
      failed: failed.length,
    });
    return { accounts: looked, failed };
  }
}
