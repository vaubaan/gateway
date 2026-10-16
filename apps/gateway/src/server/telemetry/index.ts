/**
 * Community telemetry (spec §9, §4.3, §10): the wiring between
 * the call pipeline's `TelemetrySink`, the client of `@vaubaan/telemetry`,
 * the operator's toggle and the validation status read back from the
 * collector. Built once by the composition root as `root.telemetry`.
 * Handbook: docs/handbook/telemetry.md. ADR: telemetry-collector-shape.
 *
 * Off by default, and inert until the operator turns it on AND a real
 * collector URL is configured: while `telemetry.collector_url` is the
 * placeholder default nothing leaves the instance.
 */
import type { AuditWriter, CacheClient } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import {
  collectorEndpoint,
  createPluginReport,
  isPlaceholderCollector,
  serializeBatch,
  TelemetryClient,
  type PluginReport,
  type QueueStats,
  type ReportQueueOptions,
  type TelemetryClientState,
} from '@vaubaan/telemetry';

import type { Authenticator } from '../auth/authenticator';
import { DEFAULT_TELEMETRY_COLLECTOR_URL } from '../config/telemetry-default';
import type { BuildInfo, InstanceConfig } from '../config';
import type { TelemetrySink } from '../execution/telemetry-sink';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';
import { createTelemetryHandlers, type TelemetryHandlers } from './handlers';
import { reportOf } from './outcome';
import { TelemetrySettingsService, type TelemetryState } from './settings';
import { PluginStatsReader } from './stats';

export interface TelemetryModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'telemetry'>;
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
  /** The collector URL is still the placeholder default: nothing is sent. */
  readonly placeholderCollector: boolean;
  /** The exact request body of one report, as this instance would send it. */
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
  stop(): void;
}

/**
 * A report of this instance's own shape, for the Admin page: the first tool
 * of the first registered plugin, reported as a success. `null` when no
 * plugin declares a tool.
 */
function sampleReport(registry: PluginRegistry, gatewayVersion: string): PluginReport | null {
  for (const id of registry.ids) {
    const plugin = registry.get(id)?.plugin;
    const tool = plugin?.tools[0];
    if (!plugin || !tool) continue;
    const report = createPluginReport({
      plugin: plugin.id,
      plugin_version: plugin.version,
      gateway_version: gatewayVersion,
      tool: tool.name,
      outcome: 'success',
      error_class: null,
      duration_bucket: 'lt_1s',
    });
    if (report) return report;
  }
  return null;
}

/** The body of a one-report batch, indented for display; the same serializer as the client. */
function displayPayload(report: PluginReport | null): string {
  const queued = report ? [{ kind: 'plugin-health' as const, report }] : [];
  return JSON.stringify(JSON.parse(serializeBatch(queued)), null, 2);
}

export async function createTelemetryModule(deps: TelemetryModuleDeps): Promise<TelemetryModule> {
  const logger = deps.logger.child({ component: 'telemetry' });
  const clock = deps.clock ?? systemClock;
  const { collectorUrl } = deps.config.telemetry;
  const placeholderUrl = new URL(DEFAULT_TELEMETRY_COLLECTOR_URL);
  const placeholderCollector = isPlaceholderCollector(collectorUrl, placeholderUrl);
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
    placeholderUrl,
    fetch: outbound,
    logger,
    queue: deps.queue,
  });
  clientRef.current = client;
  const initial = await settings.state();
  logger.info('telemetry', {
    enabled: initial.enabled,
    source: initial.source,
    collector: placeholderCollector ? 'placeholder (nothing is sent)' : 'configured',
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
  };

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
  const samplePayload = displayPayload(sampleReport(deps.registry, deps.build.version));

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
        placeholderCollector,
        samplePayload,
        queue: client.stats,
      };
    },
    flush: () => client.flush(),
    stop: () => client.stop(),
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
