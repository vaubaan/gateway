/**
 * Community telemetry (spec §9, §4.3, §10): the wiring between
 * the call pipeline's `TelemetrySink`, the client of `@vaubaan/telemetry`,
 * the operator's toggle and the validation status read back from the
 * collector. Built once by the composition root as `root.telemetry`.
 * Handbook: docs/handbook/telemetry.md. ADR: telemetry-collector-shape.
 *
 * Off by default, and inert until the operator turns it on: while telemetry
 * is disabled nothing leaves the instance, not even a statistics request.
 * Once on, reports go to `telemetry.collector_url` — by default the
 * project's published collector.
 */
import type { AuditWriter, CacheClient } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import {
  collectorEndpoint,
  createDecisionReport,
  createPluginReport,
  serializeBatch,
  TelemetryClient,
  type QueueStats,
  type ReportQueueOptions,
  type TelemetryClientState,
  type TelemetryLevel,
  type TelemetryReport,
} from '@vaubaan/telemetry';

import type { Authenticator } from '../auth/authenticator';
import type { BuildInfo, InstanceConfig } from '../config';
import type { TelemetrySink } from '../execution/telemetry-sink';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';
import { createTelemetryHandlers, type TelemetryHandlers } from './handlers';
import { reportOf } from './outcome';
import { TelemetrySettingsService, type TelemetryState } from './settings';
import { PluginStatsReader } from './stats';
import {
  decisionReportOf,
  InstanceProfiler,
  utcDayOf,
  type InstanceProfilerDeps,
  type ProfileSource,
} from './usage';

export interface TelemetryModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'telemetry' | 'signIn'>;
  /** Counts for the daily instance profile (level `usage-stats`). */
  readonly profileSource: ProfileSource;
  readonly store: { readonly config: ConfigRepo; readonly auditWriter: AuditWriter };
  readonly registry: PluginRegistry;
  readonly authenticator: Authenticator;
  readonly cache: CacheClient;
  readonly logger: Logger;
  readonly build: BuildInfo;
  /** Outbound HTTP to the collector. Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  /** Queue tuning and timers (tests). */
  readonly queue?: Omit<ReportQueueOptions, 'send'>;
  /** The profile check's timer (tests pass `null` and call `profileNow`). Default: every hour. */
  readonly profileIntervalMs?: number | null;
  readonly profiler?: Partial<Pick<InstanceProfilerDeps, 'env' | 'randomBytes' | 'inDocker'>>;
}

/** What Admin → Telemetry shows. */
export interface TelemetryOverview {
  readonly state: TelemetryState;
  /** The mounted configuration decides: the toggle is read-only. */
  readonly locked: boolean;
  /** Whether reports actually leave, and why not. */
  readonly client: TelemetryClientState;
  /** The collector URL in use, without the public key it may carry. */
  readonly collectorUrl: string;
  /** The configured URL carries the collector's public key. */
  readonly collectorKeySet: boolean;
  /** What an enabled instance sends (`telemetry.level`). */
  readonly level: TelemetryLevel;
  /** The exact request body of one report of each kind the level sends, as this instance would send it. */
  readonly samplePayload: string;
  readonly queue: QueueStats;
}

export interface TelemetryModule {
  /** The sink the execution module hands to the upstream stage. */
  readonly sink: TelemetrySink;
  readonly settings: TelemetrySettingsService;
  readonly stats: PluginStatsReader;
  readonly handlers: TelemetryHandlers;
  overview(): Promise<TelemetryOverview>;
  /** Sends what is queued now (tests, shutdown paths). */
  flush(): Promise<void>;
  /** Queues today's instance profile if the level sends it and none was queued today (tests). */
  profileNow(): Promise<void>;
  stop(): void;
}

/**
 * Reports of this instance's own shape, for the Admin page: the first tool of
 * the first registered plugin, reported as an allowed success; with
 * `usage-stats`, its decision and a profile with a placeholder day identifier.
 */
function sampleReports(
  registry: PluginRegistry,
  gatewayVersion: string,
  level: TelemetryLevel,
): TelemetryReport[] {
  for (const id of registry.ids) {
    const plugin = registry.get(id)?.plugin;
    const tool = plugin?.tools[0];
    if (!plugin || !tool) continue;
    const health = createPluginReport({
      plugin: plugin.id,
      plugin_version: plugin.version,
      gateway_version: gatewayVersion,
      tool: tool.name,
      outcome: 'success',
      error_class: null,
      duration_bucket: 'lt_1s',
    });
    if (!health) continue;
    const out: TelemetryReport[] = [{ kind: 'plugin-health', report: health }];
    if (level === 'usage-stats') {
      const decision = createDecisionReport({
        plugin: plugin.id,
        tool: tool.name,
        gateway_version: gatewayVersion,
        decision: 'allowed',
        risks: [],
        gate: 'none',
      });
      if (decision) out.push({ kind: 'decision', report: decision });
    }
    return out;
  }
  return [];
}

/** The body of a sample batch, indented for display; the same serializer as the client. */
function displayPayload(reports: readonly TelemetryReport[]): string {
  return JSON.stringify(JSON.parse(serializeBatch(reports)), null, 2);
}

const PROFILE_CHECK_MS = 60 * 60 * 1000;

export async function createTelemetryModule(deps: TelemetryModuleDeps): Promise<TelemetryModule> {
  const logger = deps.logger.child({ component: 'telemetry' });
  const clock = deps.clock ?? systemClock;
  const { collectorUrl } = deps.config.telemetry;
  const outbound = deps.fetch ?? ((input, init) => fetch(input, init));

  // The settings and the client refer to each other: the client asks the
  // settings on every report, the settings empty the client's queue when
  // telemetry turns off.
  const clientRef: { current: TelemetryClient | null } = { current: null };
  const settings = new TelemetrySettingsService({
    config: deps.config.telemetry,
    store: deps.store.config,
    logger,
    clock,
    onChange: (state) => {
      if (!state.enabled) clientRef.current?.discardQueued();
    },
  });
  const client = new TelemetryClient({
    isEnabled: () => settings.enabledNow(),
    collectorUrl,
    fetch: outbound,
    logger,
    queue: deps.queue,
  });
  clientRef.current = client;
  const initial = await settings.state();
  logger.info('telemetry', {
    enabled: initial.enabled,
    source: initial.source,
    collector: collectorEndpoint(collectorUrl).url.href,
  });

  const { level } = deps.config.telemetry;
  const usage = level === 'usage-stats';
  const profiler = new InstanceProfiler({
    registry: deps.registry,
    gatewayVersion: deps.build.version,
    signInKinds: [...new Set(deps.config.signIn.map((provider) => provider.kind))],
    source: deps.profileSource,
    ...deps.profiler,
  });

  const sink: TelemetrySink = {
    pluginExecuted(execution) {
      try {
        // Cheapest gate first: a disabled instance does not even classify.
        if (client.state === 'disabled') return;
        const report = reportOf(execution, deps.build.version);
        if (report) client.record({ kind: 'plugin-health', report });
      } catch {
        // Telemetry never fails a call, and an error here may carry provider text: not logged.
      }
    },
    callDecided(decision) {
      try {
        if (!usage || client.state === 'disabled') return;
        profiler.countCall();
        const report = decisionReportOf(decision, deps.registry, deps.build.version);
        if (report) client.record({ kind: 'decision', report });
      } catch {
        // Telemetry never fails a call.
      }
    },
  };

  // One profile per UTC day, checked every hour: the first check of a day
  // that finds telemetry sending queues it.
  let profiledDay: string | null = null;
  let profiling: Promise<void> | null = null;
  async function profileNow(): Promise<void> {
    if (!usage || client.state !== 'sending') return;
    const now = clock.now();
    const day = utcDayOf(now);
    if (profiledDay === day) return;
    const profile = await profiler.profile(now);
    if (profile) {
      client.record({ kind: 'instance-profile', report: profile });
      profiledDay = day;
    }
  }
  const tick = (): void => {
    profiling ??= profileNow()
      .catch((error: unknown) =>
        logger.warn('telemetry: the instance profile could not be built', {
          error: error instanceof Error ? error.name : 'non_error_throw',
        }),
      )
      .finally(() => {
        profiling = null;
      });
  };
  const intervalMs =
    deps.profileIntervalMs === undefined ? PROFILE_CHECK_MS : deps.profileIntervalMs;
  const timer = intervalMs === null ? null : setInterval(tick, intervalMs);
  timer?.unref();

  const stats = new PluginStatsReader({
    isActive: () => client.state === 'sending',
    collectorUrl,
    registry: deps.registry,
    cache: deps.cache,
    fetch: outbound,
    logger,
  });

  const handlers = createTelemetryHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    settings,
    audit: deps.store.auditWriter,
    logger,
    clock,
  });

  const endpoint = collectorEndpoint(collectorUrl);
  const samplePayload = displayPayload(sampleReports(deps.registry, deps.build.version, level));

  return {
    sink,
    settings,
    stats,
    handlers,
    async overview() {
      const state = await settings.state();
      return {
        state,
        locked: settings.isLocked(),
        client: client.state,
        collectorUrl: endpoint.url.href,
        collectorKeySet: endpoint.key !== null,
        level,
        samplePayload,
        queue: client.stats,
      };
    },
    flush: () => client.flush(),
    profileNow,
    stop: () => {
      if (timer) clearInterval(timer);
      client.stop();
    },
  };
}

export {
  ENABLED_FIELD,
  PROBLEM_PARAM,
  TELEMETRY_ACTION,
  TELEMETRY_PAGE,
  type TelemetryHandlers,
  type TelemetryProblem,
} from './handlers';
export { classifyOutcome, reportOf } from './outcome';
export {
  decisionReportOf,
  deploymentKindOf,
  InstanceProfiler,
  utcDayOf,
  type InstanceProfilerDeps,
  type ProfileSource,
} from './usage';
export {
  REFRESH_MS,
  TELEMETRY_CONFIG_OBJECT_ID,
  TELEMETRY_ENABLED_KEY,
  TelemetryLockedError,
  TelemetrySettingsService,
  type TelemetrySource,
  type TelemetryState,
} from './settings';
export {
  FAILURE_TTL_SECONDS,
  parsePluginStats,
  PLUGIN_STATS_RESOURCE,
  PluginStatsReader,
  pluginStatsUrl,
  STATS_CACHE_KEY,
  STATS_TTL_SECONDS,
  type ValidationStatus,
} from './stats';
