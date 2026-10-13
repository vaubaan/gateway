/**
 * Community validation status of the plugins (spec §9 "the instance's
 * interface shows this status on each connection").
 *
 * The collector publishes `plugin_stats` beside the endpoint that receives
 * reports (`deploy/collector/schema.sql`): one row per `(plugin,
 * plugin_version, tool)` and one row per `(plugin, plugin_version)` whose
 * `tool` is null. This reader asks for the second kind, for the plugins this
 * instance registers, and answers the row of the version it runs.
 *
 * Optional by construction:
 *
 *   - nothing is fetched unless telemetry is enabled AND a real collector is
 *     configured — an instance that does not contribute makes no request at
 *     all to the collector, statistics included;
 *   - `statusFor` never waits for the network: it answers what is cached
 *     (possibly nothing) and refreshes in the background, so a slow or dead
 *     collector never slows a page;
 *   - any failure (network, status, shape) leaves the badge absent and is
 *     remembered for `FAILURE_TTL_SECONDS` before the next attempt.
 *
 * The request carries the ids of the registered plugins and nothing about
 * the instance.
 *
 * // single-process only — `refreshing` dedupes concurrent refreshes inside
 * // one process; the snapshot itself goes through `CacheClient`, which a
 * // multi-replica deployment already replaces with a shared implementation.
 */
import type { CacheClient } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { collectorEndpoint, collectorHeaders, REPORT_FIELD_PATTERNS } from '@vaubaan/telemetry';

import type { Logger } from '../logging';

/** The resource published beside the reports endpoint: its last path segment is replaced by this. */
export const PLUGIN_STATS_RESOURCE = 'plugin_stats';
export const STATS_CACHE_KEY = 'telemetry:plugin-stats';
export const STATS_TTL_SECONDS = 6 * 60 * 60;
export const FAILURE_TTL_SECONDS = 10 * 60;
export const STATS_TIMEOUT_MS = 5_000;
/** A response larger than this is not a statistics page of a few plugins. */
export const STATS_MAX_BYTES = 512 * 1024;

const STATS_COLUMNS = 'plugin,plugin_version,reports,success_rate,validated';

export interface ValidationStatus {
  /** Above both published thresholds (success rate, number of reports). */
  readonly validated: boolean;
  readonly reports: number;
  /** 0 to 1. */
  readonly successRate: number;
}

/** What is cached: the rows by `plugin@version`, or the memory of a failure. */
type Snapshot =
  | { readonly ok: true; readonly byPlugin: Readonly<Record<string, ValidationStatus>> }
  | { readonly ok: false };

export interface PluginStatsDeps {
  /** Telemetry is enabled and the collector is not the placeholder. */
  readonly isActive: () => boolean;
  /** The collector URL in use (reports endpoint). */
  readonly collectorUrl: URL;
  readonly registry: Pick<PluginRegistry, 'ids' | 'get'>;
  readonly cache: CacheClient;
  readonly fetch: typeof fetch;
  readonly logger: Logger;
}

function statusKey(plugin: string, version: string): string {
  return `${plugin}@${version}`;
}

/**
 * The statistics URL: the reports URL with its last path segment replaced by
 * `plugin_stats`, asking for the plugin-level rows of the given plugins.
 */
export function pluginStatsUrl(collectorUrl: URL, pluginIds: readonly string[]): URL {
  const { url } = collectorEndpoint(collectorUrl);
  const segments = url.pathname.split('/');
  segments[segments.length - 1] = PLUGIN_STATS_RESOURCE;
  url.pathname = segments.join('/');
  url.search = '';
  url.searchParams.set('select', STATS_COLUMNS);
  url.searchParams.set('tool', 'is.null');
  url.searchParams.set('plugin', `in.(${pluginIds.join(',')})`);
  return url;
}

function parseRow(row: unknown): [string, ValidationStatus] | null {
  if (typeof row !== 'object' || row === null) return null;
  const { plugin, plugin_version, reports, success_rate, validated } = row as Record<
    string,
    unknown
  >;
  if (typeof plugin !== 'string' || !REPORT_FIELD_PATTERNS.plugin.test(plugin)) return null;
  if (typeof plugin_version !== 'string' || !REPORT_FIELD_PATTERNS.version.test(plugin_version)) {
    return null;
  }
  // PostgREST serializes `numeric` as a JSON number and `bigint` as a number too.
  const count = Number(reports);
  const rate = Number(success_rate);
  if (!Number.isInteger(count) || count < 0) return null;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  if (typeof validated !== 'boolean') return null;
  return [statusKey(plugin, plugin_version), { validated, reports: count, successRate: rate }];
}

/** The rows of a `plugin_stats` answer, by `plugin@version`; malformed rows are skipped. */
export function parsePluginStats(body: unknown): Record<string, ValidationStatus> | null {
  if (!Array.isArray(body)) return null;
  const out: Record<string, ValidationStatus> = {};
  for (const row of body) {
    const parsed = parseRow(row);
    if (parsed) out[parsed[0]] = parsed[1];
  }
  return out;
}

export class PluginStatsReader {
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: PluginStatsDeps) {}

  /**
   * The community status of a plugin at the version this instance runs, or
   * `null` when there is none to show (telemetry off, no collector, nothing
   * cached yet, no report for that version, collector unavailable).
   */
  async statusFor(pluginId: string): Promise<ValidationStatus | null> {
    if (!this.deps.isActive()) return null;
    const registered = this.deps.registry.get(pluginId);
    if (!registered) return null;
    const snapshot = await this.deps.cache.get<Snapshot>(STATS_CACHE_KEY);
    if (snapshot === null) {
      // Not awaited: the page renders without the badge, the next one has it.
      void this.refresh();
      return null;
    }
    if (!snapshot.ok) return null;
    return snapshot.byPlugin[statusKey(pluginId, registered.plugin.version)] ?? null;
  }

  /** Fetches and caches the statistics now (joins a refresh in flight). Never rejects. */
  refresh(): Promise<void> {
    if (!this.deps.isActive()) return Promise.resolve();
    this.refreshing ??= this.fetchAndCache().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fetchAndCache(): Promise<void> {
    const { cache, logger } = this.deps;
    try {
      const byPlugin = await this.fetchStats();
      await cache.set<Snapshot>(STATS_CACHE_KEY, { ok: true, byPlugin }, STATS_TTL_SECONDS);
    } catch (err) {
      logger.debug('telemetry: plugin statistics unavailable', {
        reason: err instanceof StatsUnavailable ? err.reason : 'unreachable',
      });
      await cache
        .set<Snapshot>(STATS_CACHE_KEY, { ok: false }, FAILURE_TTL_SECONDS)
        .catch(() => undefined);
    }
  }

  private async fetchStats(): Promise<Record<string, ValidationStatus>> {
    const { collectorUrl, registry } = this.deps;
    const ids = registry.ids.filter((id) => REPORT_FIELD_PATTERNS.plugin.test(id));
    if (ids.length === 0) return {};
    const response = await this.deps.fetch(pluginStatsUrl(collectorUrl, ids), {
      method: 'GET',
      headers: {
        ...collectorHeaders(collectorEndpoint(collectorUrl).key),
        accept: 'application/json',
      },
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new StatsUnavailable(`status ${response.status}`);
    }
    const text = await response.text();
    if (text.length > STATS_MAX_BYTES) throw new StatsUnavailable('answer too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new StatsUnavailable('not JSON');
    }
    const parsed = parsePluginStats(body);
    if (parsed === null) throw new StatsUnavailable('not a list of rows');
    return parsed;
  }
}

class StatsUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'StatsUnavailable';
  }
}
