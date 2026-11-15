/**
 * Accounts refresh themselves (spec §0 "Resource", §4.2 "Accounts"): their resources and
 * what their key may do are asked again without anyone pressing "Refresh".
 *
 * - **Hourly.** A tick every minute picks the accounts that are due and refreshes them one
 *   after the other. Each account has its own slot in the interval, a stable hash of its id
 *   (`phaseOf`), so the accounts of one service are spread over the hour instead of hitting
 *   it together, and a restart does not send every account at once. An account is due when
 *   its slot passed since its last refresh and at least half an interval went by (`isDue`):
 *   a refresh on open just before its slot is not repeated at the slot.
 * - **On open.** A page that shows an account whose last refresh is older than
 *   `STALE_AFTER_MS` asks for it (`refreshStale`); an account never refreshed is left to
 *   the hourly run (a seeded or `ssh-key` account the page cannot judge).
 * - **Back-off.** A refresh that fails (service unreachable, 429, 5xx) puts the account aside
 *   for one interval, then two, four, eight (`backoffMs`), hourly and on open alike; a
 *   success clears it. A key the service rejects turns the account `expired` (the
 *   service's rule), which takes it out of the next runs.
 *
 * Which accounts: every `active` one, and the ones a running mission's set with future on
 * depends on (an `unowned` account's missions keep running); never a host account (no
 * secret, nothing to discover). `accounts.refresh_interval` = 0 turns all of it off.
 *
 * Single-process: one tick at a time, one refresh per account at a time (a page asking for
 * an account the tick is refreshing waits for that refresh). Failures are logged by account
 * only, never the service's words (handbook accounts).
 */
import type { Logger } from '../logging';
import type { AccountsRepo, MissionsRepo } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { AccountRecord } from '../store/types';
import { lastDiscoveryAt } from './mapping';
import { isHostAccount, type AccountService, type AutomaticRefresh } from './service';

/** The default of `accounts.refresh_interval`. */
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** A page refreshes an account it shows when its last refresh is older than this. */
export const STALE_AFTER_MS = 15 * 60 * 1000;
/** How often the scheduler looks for due accounts. */
export const REFRESH_TICK_MS = 60 * 1000;
/** The longest back-off, in intervals. */
export const MAX_BACKOFF_INTERVALS = 8;
/** At most this many accounts refreshed at once for one page. */
export const ON_OPEN_CONCURRENCY = 3;

export interface RefreshTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: RefreshTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ── The rules, pure ─────────────────────────────────────────────────────────

/** The account's slot in the interval: a stable hash of its id (FNV-1a), in ms. */
export function phaseOf(accountId: string, intervalMs: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < accountId.length; i += 1) {
    hash ^= accountId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % intervalMs;
}

/** The latest instant at or before `nowMs` that is the account's slot. */
export function lastSlotAt(accountId: string, nowMs: number, intervalMs: number): number {
  const phase = phaseOf(accountId, intervalMs);
  const since = (((nowMs - phase) % intervalMs) + intervalMs) % intervalMs;
  return nowMs - since;
}

/**
 * Due on the hourly run: its slot came since `lastMs` (the last refresh, or the
 * account's creation when it was never refreshed), and half an interval went by.
 */
export function isDue(
  accountId: string,
  lastMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0) return false;
  return lastMs < lastSlotAt(accountId, nowMs, intervalMs) && nowMs - lastMs >= intervalMs / 2;
}

/** Stale for a page: refreshed once, longer ago than `staleAfterMs`. */
export function isStale(lastMs: number | null, nowMs: number, staleAfterMs: number): boolean {
  return lastMs !== null && nowMs - lastMs >= staleAfterMs;
}

/** How long an account is put aside after `failures` refreshes failed in a row. */
export function backoffMs(failures: number, intervalMs: number): number {
  if (failures <= 0) return 0;
  return intervalMs * Math.min(2 ** (failures - 1), MAX_BACKOFF_INTERVALS);
}

function timeOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ── The scheduler ───────────────────────────────────────────────────────────

export interface AccountRefresherDeps {
  readonly accounts: Pick<AccountsRepo, 'list' | 'getById'>;
  readonly missions: Pick<MissionsRepo, 'accountsWithFutureSets'>;
  readonly service: Pick<AccountService, 'refreshOnItsOwn'>;
  readonly logger: Logger;
  readonly clock: Clock;
  /** `accounts.refresh_interval`; 0 turns the automatic refresh off. */
  readonly intervalMs: number;
  readonly timers?: RefreshTimers;
  /** Tests: another staleness window or tick. */
  readonly staleAfterMs?: number;
  readonly tickMs?: number;
}

/** What one hourly tick did. */
export interface RefreshRun {
  /** The accounts it refreshed, in order. */
  readonly accounts: readonly string[];
  /** The ones whose refresh failed (recorded on the account, then backed off). */
  readonly failed: readonly string[];
}

/** What a page's refresh did. */
export interface OnOpenRefresh {
  /** The accounts refreshed (stale, not backed off). */
  readonly refreshed: readonly string[];
  /** Among them, the ones whose resources, rights or state changed: the page reads again. */
  readonly changed: readonly string[];
}

interface Backoff {
  readonly failures: number;
  readonly untilMs: number;
}

export class AccountRefresher {
  private readonly timers: RefreshTimers;
  private readonly staleAfterMs: number;
  private readonly tickMs: number;
  private timer: unknown = null;
  private running: Promise<RefreshRun> | null = null;
  private stopped = false;
  private readonly inFlight = new Map<string, Promise<AutomaticRefresh | null>>();
  private readonly backoff = new Map<string, Backoff>();

  constructor(private readonly deps: AccountRefresherDeps) {
    this.timers = deps.timers ?? NODE_TIMERS;
    this.staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS;
    this.tickMs = deps.tickMs ?? REFRESH_TICK_MS;
  }

  /** False when `accounts.refresh_interval` is 0: nothing refreshes on its own. */
  get enabled(): boolean {
    return this.deps.intervalMs > 0;
  }

  /** Arms the tick (nothing when disabled); the first tick comes one tick later. */
  start(): void {
    if (!this.enabled) return;
    this.stopped = false;
    this.arm();
  }

  /** Disarms the tick and waits for the refreshes in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** One tick now, or the tick already in progress. Never throws. */
  runOnce(): Promise<RefreshRun> {
    this.running ??= this.tick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * The ids among `accounts` a page should ask to refresh: stale, not backed off, and
   * serving. Empty when the automatic refresh is off.
   */
  staleAmong(accounts: readonly AccountRecord[]): string[] {
    if (!this.enabled) return [];
    const now = this.deps.clock.now().getTime();
    return accounts
      .filter((account) => this.refreshableNow(account, now))
      .filter((account) => isStale(timeOf(lastDiscoveryAt(account)), now, this.staleAfterMs))
      .map((account) => account.id);
  }

  /** `staleAmong` by id, read from the store; unknown ids are left out. */
  async staleIds(accountIds: readonly string[]): Promise<string[]> {
    if (!this.enabled) return [];
    const records: AccountRecord[] = [];
    for (const id of new Set(accountIds)) {
      const account = await this.deps.accounts.getById(id);
      if (account) records.push(account);
    }
    return this.staleAmong(records);
  }

  /**
   * A page's refresh: of `accountIds` (already checked visible to the reader), the
   * stale ones, a few at a time. Never throws.
   */
  async refreshStale(accountIds: readonly string[]): Promise<OnOpenRefresh> {
    if (!this.enabled) return { refreshed: [], changed: [] };
    const queue = await this.staleIds(accountIds);
    const refreshed: string[] = [];
    const changed: string[] = [];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const outcome = await this.refreshOne(id, 'on-open');
        if (!outcome) continue;
        refreshed.push(id);
        if (outcome.changed) changed.push(id);
      }
    };
    await Promise.all(Array.from({ length: ON_OPEN_CONCURRENCY }, worker));
    return { refreshed, changed };
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.arm());
    }, this.tickMs);
  }

  private async tick(): Promise<RefreshRun> {
    const looked: string[] = [];
    const failed: string[] = [];
    let due: string[];
    try {
      due = await this.dueAccounts();
    } catch (error) {
      this.deps.logger.warn('account refresh could not list its accounts', {
        error_class: error instanceof Error ? error.name : typeof error,
      });
      return { accounts: [], failed: [] };
    }
    for (const accountId of due) {
      if (this.stopped) break;
      const outcome = await this.refreshOne(accountId, 'scheduled');
      if (!outcome) continue;
      looked.push(accountId);
      if (!outcome.record.ok) failed.push(accountId);
    }
    if (looked.length > 0) {
      this.deps.logger.info('accounts refreshed on schedule', {
        accounts: looked.length,
        failed: failed.length,
      });
    }
    return { accounts: looked, failed };
  }

  /** The accounts due now, in the order of their slots. */
  private async dueAccounts(): Promise<string[]> {
    const now = this.deps.clock.now();
    const nowMs = now.getTime();
    const active = await this.deps.accounts.list({ status: 'active' });
    const futureIds = await this.deps.missions.accountsWithFutureSets(toIso(now));
    const byId = new Map(active.map((account) => [account.id, account] as const));
    for (const id of futureIds) {
      if (byId.has(id)) continue;
      const account = await this.deps.accounts.getById(id);
      if (account) byId.set(id, account);
    }
    const { intervalMs } = this.deps;
    return [...byId.values()]
      .filter((account) => this.refreshableNow(account, nowMs))
      .filter((account) => {
        const last = timeOf(lastDiscoveryAt(account)) ?? timeOf(account.createdAt) ?? nowMs;
        return isDue(account.id, last, nowMs, intervalMs);
      })
      .sort(
        (a, b) =>
          lastSlotAt(a.id, nowMs, intervalMs) - lastSlotAt(b.id, nowMs, intervalMs) ||
          a.id.localeCompare(b.id),
      )
      .map((account) => account.id);
  }

  /** Serving, not a host account, not backed off. */
  private refreshableNow(account: AccountRecord, nowMs: number): boolean {
    if (account.status !== 'active' && account.status !== 'unowned') return false;
    if (isHostAccount(account)) return false;
    const aside = this.backoff.get(account.id);
    return aside === undefined || aside.untilMs <= nowMs;
  }

  /** One refresh of the account, shared with a refresh of it already under way. */
  private refreshOne(
    accountId: string,
    cause: 'scheduled' | 'on-open',
  ): Promise<AutomaticRefresh | null> {
    const pending = this.inFlight.get(accountId);
    if (pending) return pending;
    const started = this.refreshNow(accountId, cause).finally(() => {
      this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, started);
    return started;
  }

  private async refreshNow(
    accountId: string,
    cause: 'scheduled' | 'on-open',
  ): Promise<AutomaticRefresh | null> {
    let outcome: AutomaticRefresh | null;
    try {
      outcome = await this.deps.service.refreshOnItsOwn(accountId, cause);
    } catch (error) {
      this.deps.logger.warn('account refresh failed', {
        account_id: accountId,
        cause,
        error_class: error instanceof Error ? error.name : typeof error,
      });
      this.putAside(accountId);
      return null;
    }
    if (outcome && !outcome.record.ok) this.putAside(accountId);
    else this.backoff.delete(accountId);
    return outcome;
  }

  private putAside(accountId: string): void {
    const failures = (this.backoff.get(accountId)?.failures ?? 0) + 1;
    const untilMs = this.deps.clock.now().getTime() + backoffMs(failures, this.deps.intervalMs);
    this.backoff.set(accountId, { failures, untilMs });
  }
}
