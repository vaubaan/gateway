/**
 * Who decides whether this instance sends telemetry (spec §9 "opt-in per
 * instance, disabled at installation, enabled by the operator"; §4.3).
 *
 *   1. the mounted configuration sets `telemetry.enabled` (true or false)
 *        → that value, and the Admin toggle is read-only (the file wins,
 *          like every other setting the file and the Admin page share);
 *   2. otherwise the operator's toggle, stored as `telemetry.enabled` in
 *      `instance_config`;
 *   3. otherwise off.
 *
 * The client asks on every report, synchronously, so the service keeps the
 * effective value in memory: loaded at boot, replaced when the operator
 * toggles, and re-read from the store when older than `REFRESH_MS`.
 *
 * // single-process only — the in-memory value is this process's view of
 * // `instance_config`. Another replica toggling is seen after at most
 * // `REFRESH_MS` through the periodic re-read; a deployment that needs it
 * // sooner publishes the change on the bus that would replace the timer.
 */
import type { TelemetryConfig } from '../config/types';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';

export const TELEMETRY_ENABLED_KEY = 'telemetry.enabled';
/** `object.id` of the audit entry of a toggle. */
export const TELEMETRY_CONFIG_OBJECT_ID = 'telemetry';
export const REFRESH_MS = 30_000;

const ON = 'true';
const OFF = 'false';

/** Where the effective value comes from. */
export type TelemetrySource = 'config' | 'admin' | 'default';

export interface TelemetryState {
  readonly enabled: boolean;
  readonly source: TelemetrySource;
}

export class TelemetryLockedError extends Error {
  constructor() {
    super(
      'telemetry.enabled is set by the mounted configuration; change it there ' +
        '(telemetry.enabled / VAUBAAN_TELEMETRY_ENABLED)',
    );
    this.name = 'TelemetryLockedError';
  }
}

export interface TelemetrySettingsDeps {
  readonly config: Pick<TelemetryConfig, 'enabled' | 'enabledSetByConfig'>;
  readonly store: Pick<ConfigRepo, 'get' | 'set'>;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Called after the effective value changed (the client empties its queue when it turns off). */
  readonly onChange?: (state: TelemetryState) => void;
}

export class TelemetrySettingsService {
  private readonly clock: Clock;
  private current: TelemetryState;
  private readAtMs = 0;
  private refreshing = false;

  constructor(private readonly deps: TelemetrySettingsDeps) {
    this.clock = deps.clock ?? systemClock;
    this.current = deps.config.enabledSetByConfig
      ? { enabled: deps.config.enabled, source: 'config' }
      : { enabled: false, source: 'default' };
  }

  /** True when the mounted configuration decides: the Admin toggle cannot change it. */
  isLocked(): boolean {
    return this.deps.config.enabledSetByConfig;
  }

  /**
   * The effective state, from the store when the configuration does not
   * decide. Called once at boot, before the first call is served.
   */
  async state(): Promise<TelemetryState> {
    return this.reload();
  }

  /**
   * The effective value, without waiting. A value older than `REFRESH_MS` is
   * still answered, and re-read in the background.
   */
  enabledNow(): boolean {
    if (!this.isLocked() && this.clock.now().getTime() - this.readAtMs > REFRESH_MS) {
      this.refreshInBackground();
    }
    return this.current.enabled;
  }

  /**
   * The operator's toggle. Refused while the configuration decides. Returns
   * the state before and after, for the audit entry.
   */
  async setEnabled(enabled: boolean): Promise<{ before: TelemetryState; after: TelemetryState }> {
    if (this.isLocked()) throw new TelemetryLockedError();
    const before = await this.reload();
    await this.deps.store.set(TELEMETRY_ENABLED_KEY, enabled ? ON : OFF);
    const after = await this.reload();
    return { before, after };
  }

  private async reload(): Promise<TelemetryState> {
    if (this.isLocked()) return this.current;
    const stored = await this.deps.store.get(TELEMETRY_ENABLED_KEY);
    const next: TelemetryState =
      stored === null
        ? { enabled: false, source: 'default' }
        : { enabled: stored === ON, source: 'admin' };
    this.readAtMs = this.clock.now().getTime();
    const changed = next.enabled !== this.current.enabled;
    this.current = next;
    if (changed) this.deps.onChange?.(next);
    return next;
  }

  private refreshInBackground(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    this.reload()
      .catch((err: unknown) => {
        // The last known value stands; a store that cannot be read is logged elsewhere too.
        this.deps.logger.warn('telemetry: the stored toggle could not be re-read', { err });
        this.readAtMs = this.clock.now().getTime();
      })
      .finally(() => {
        this.refreshing = false;
      });
  }
}
