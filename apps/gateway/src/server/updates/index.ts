/**
 * The versions check (spec §4.3 `updates.*`; ADR plugins-bundled-or-pinned-by-the-operator):
 * at start, after a short delay, then every 24 h, the instance reads the published
 * versions feed and compares it with what it runs. The result is kept in memory for
 * Administration › Plugins; nothing is downloaded, nothing about the instance leaves it.
 *
 * Off (`updates.check: false`), no request is ever made and `current()` stays `null`.
 * A failed read never throws out of the scheduler: it is logged, and the last report
 * read stays (with its `checkedAt`).
 */
import type { UpdatesConfig } from '../config';
import type { Logger } from '../logging';
import type { PluginInventoryEntry } from '../plugins';
import { compare, type UpdatesComparison } from './compare';
import { readVersionsFeed, type FeedReadFailure } from './fetch-feed';
export {
  createUpdatesHandlers,
  PLUGINS_PAGE,
  UPDATES_CHECK_ACTION,
  type UpdatesHandlerDeps,
  type UpdatesHandlers,
} from './handlers';

export {
  compare,
  type AdvisoryHit,
  type CompareInput,
  type GatewayVersionCheck,
  type OlderPin,
  type PluginBehind,
  type UpdatesComparison,
} from './compare';
export {
  FEED_MAX_BYTES,
  FEED_TIMEOUT_MS,
  FEED_USER_AGENT,
  readVersionsFeed,
  type FeedRead,
  type FeedReadFailure,
} from './fetch-feed';

/** The first read waits this long after the start: the instance serves first. */
export const FIRST_CHECK_DELAY_MS = 60_000;
/** Then one read a day. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What Administration shows: the comparison, and when the feed was read. */
export interface UpdatesReport extends UpdatesComparison {
  /** ISO 8601: when this instance read the feed. */
  readonly checkedAt: string;
}

/** The last read that failed, while no later one succeeded. */
export interface UpdatesFailure {
  readonly at: string;
  readonly failure: FeedReadFailure;
  readonly status?: number;
}

export interface UpdatesTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: UpdatesTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface UpdatesModuleDeps {
  readonly config: UpdatesConfig;
  /** The version this gateway runs (`BuildInfo.version`; `dev` outside a release). */
  readonly gatewayVersion: string;
  readonly inventory: readonly PluginInventoryEntry[];
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly timers?: UpdatesTimers;
  readonly now?: () => Date;
}

export interface UpdatesModule {
  /** The last report read; `null` before the first answer, or when the check is off. */
  current(): UpdatesReport | null;
  /** The last failed read, `null` once a read succeeds. */
  lastFailure(): UpdatesFailure | null;
  /** Reads the feed now (one read at a time); `null` when off or when the read failed. */
  refresh(): Promise<UpdatesReport | null>;
  /** Arms the first read and the daily one; nothing when the check is off. */
  start(): void;
  /** Disarms the timer; a read in progress finishes and is kept. */
  stop(): void;
}

export function createUpdatesModule(deps: UpdatesModuleDeps): UpdatesModule {
  const timers = deps.timers ?? NODE_TIMERS;
  const now = deps.now ?? (() => new Date());
  const fetchFn = deps.fetch ?? fetch;
  const logger = deps.logger.child({ component: 'updates' });
  let report: UpdatesReport | null = null;
  let failure: UpdatesFailure | null = null;
  let inFlight: Promise<UpdatesReport | null> | null = null;
  let handle: unknown = null;
  let stopped = false;

  async function read(): Promise<UpdatesReport | null> {
    const result = await readVersionsFeed(deps.config.feedUrl, { fetch: fetchFn });
    const at = now().toISOString();
    if (!result.ok) {
      failure = { at, failure: result.failure, status: result.status };
      logger.info('versions feed not read', {
        feed: deps.config.feedUrl.origin,
        failure: result.failure,
        status: result.status,
      });
      return null;
    }
    failure = null;
    report = {
      checkedAt: at,
      ...compare(result.feed, { gatewayVersion: deps.gatewayVersion, inventory: deps.inventory }),
    };
    logger.info('versions feed read', {
      gateway_behind: report.gateway.behind,
      plugins_behind: report.pluginsBehind.length,
      advisories: report.advisories.length,
      older_pins: report.olderPins.length,
    });
    return report;
  }

  function refresh(): Promise<UpdatesReport | null> {
    if (!deps.config.check) return Promise.resolve(null);
    inFlight ??= read()
      .catch((err: unknown) => {
        // Unreachable by construction (`readVersionsFeed` returns its failures); kept so
        // nothing a read does ever escapes into the timer.
        logger.warn('versions check failed', { err });
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function arm(ms: number): void {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      handle = null;
      void refresh().finally(() => arm(CHECK_INTERVAL_MS));
    }, ms);
  }

  return {
    current: () => (deps.config.check ? report : null),
    lastFailure: () => (deps.config.check ? failure : null),
    refresh,
    start() {
      if (!deps.config.check || handle !== null) return;
      stopped = false;
      arm(FIRST_CHECK_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}
