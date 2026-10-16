/**
 * The request body an instance sends and the collector accepts (ADR
 * telemetry-two-levels-behind-a-vercel-collector, D3):
 *
 *   { "plugin_health": [...], "decisions": [...], "instance_profiles": [...] }
 *
 * Each array may be absent or empty; together they hold 1 to
 * `MAX_REPORTS_PER_BATCH` reports. The same module serializes on the instance
 * and parses on the collector, so both ends apply one definition of a valid
 * report.
 *
 * Serializing rebuilds every report through its constructor: a value that
 * reached the queue by a cast leaves with its vetted keys or not at all.
 * Parsing is stricter than constructing: a report with a key its shape does
 * not define, or a value its constructor refuses, makes the whole batch
 * invalid — a client that sends one is not a client of this project.
 */
import {
  createPluginReport,
  PLUGIN_REPORT_KEYS,
  type PluginReport,
  type PluginReportInput,
} from './report.ts';
import {
  createDecisionReport,
  createInstanceProfile,
  DECISION_REPORT_KEYS,
  INSTANCE_PROFILE_KEYS,
  PROFILE_PLUGIN_KEYS,
  type DecisionReport,
  type DecisionReportInput,
  type InstanceProfile,
  type InstanceProfileInput,
} from './usage.ts';

export const MAX_REPORTS_PER_BATCH = 50;
/**
 * An instance sends one profile a day: more than two in a batch is not an
 * instance catching up. Keeps the rows of a request under the collector's
 * per-statement limit (two profiles of at most 64 plugins each).
 */
export const MAX_PROFILES_PER_BATCH = 2;
export const BATCH_KEYS = ['plugin_health', 'decisions', 'instance_profiles'] as const;

/** One queued report, tagged with its kind. */
export type TelemetryReport =
  | { readonly kind: 'plugin-health'; readonly report: PluginReport }
  | { readonly kind: 'decision'; readonly report: DecisionReport }
  | { readonly kind: 'instance-profile'; readonly report: InstanceProfile };

export type TelemetryReportKind = TelemetryReport['kind'];

export interface ReportBatch {
  readonly plugin_health: readonly PluginReport[];
  readonly decisions: readonly DecisionReport[];
  readonly instance_profiles: readonly InstanceProfile[];
}

export function batchSize(batch: ReportBatch): number {
  return batch.plugin_health.length + batch.decisions.length + batch.instance_profiles.length;
}

/** The request body for queued reports; a report its constructor now refuses is left out. */
export function serializeBatch(reports: readonly TelemetryReport[]): string {
  const plugin_health: PluginReport[] = [];
  const decisions: DecisionReport[] = [];
  const instance_profiles: InstanceProfile[] = [];
  for (const entry of reports) {
    if (entry.kind === 'plugin-health') {
      const report = createPluginReport(entry.report);
      if (report !== null) plugin_health.push(report);
    } else if (entry.kind === 'decision') {
      const report = createDecisionReport(entry.report);
      if (report !== null) decisions.push(report);
    } else {
      const report = createInstanceProfile(entry.report);
      if (report !== null) instance_profiles.push(report);
    }
  }
  const body: Partial<Record<(typeof BATCH_KEYS)[number], unknown[]>> = {};
  if (plugin_health.length > 0) body.plugin_health = plugin_health;
  if (decisions.length > 0) body.decisions = decisions;
  if (instance_profiles.length > 0) body.instance_profiles = instance_profiles;
  return JSON.stringify(body);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Exactly these keys, all present. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseList<T>(
  value: unknown,
  keys: readonly string[],
  build: (item: Record<string, unknown>) => T | null,
): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !hasExactKeys(item, keys)) return null;
    const built = build(item);
    if (built === null) return null;
    out.push(built);
  }
  return out;
}

function buildProfile(item: Record<string, unknown>): InstanceProfile | null {
  const plugins = item.plugins;
  if (!Array.isArray(plugins)) return null;
  for (const plugin of plugins) {
    if (!isPlainObject(plugin) || !hasExactKeys(plugin, PROFILE_PLUGIN_KEYS)) return null;
  }
  return createInstanceProfile(item as unknown as InstanceProfileInput);
}

/** The batch a collector may store, or `null` when anything in `value` is not one. */
export function parseBatch(value: unknown): ReportBatch | null {
  if (!isPlainObject(value)) return null;
  if (!Object.keys(value).every((key) => (BATCH_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const plugin_health = parseList(value.plugin_health, PLUGIN_REPORT_KEYS, (item) =>
    createPluginReport(item as unknown as PluginReportInput),
  );
  const decisions = parseList(value.decisions, DECISION_REPORT_KEYS, (item) =>
    createDecisionReport(item as unknown as DecisionReportInput),
  );
  const instance_profiles = parseList(value.instance_profiles, INSTANCE_PROFILE_KEYS, buildProfile);
  if (plugin_health === null || decisions === null || instance_profiles === null) return null;
  const batch: ReportBatch = { plugin_health, decisions, instance_profiles };
  const size = batchSize(batch);
  if (size === 0 || size > MAX_REPORTS_PER_BATCH) return null;
  if (instance_profiles.length > MAX_PROFILES_PER_BATCH) return null;
  return batch;
}
