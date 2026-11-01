/**
 * Plugin health on the site (website spec §2.4): the collector's public
 * aggregates, read at request time and refreshed at most hourly
 * (`src/site/live.ts`). The collector is optional and may be down or not
 * deployed: any failure or a malformed answer reads "not read", never a rate,
 * never a failed page. Below the published minimum of reports the site shows
 * the count and the minimum, never a rate.
 */
import type { ValidationThresholds } from './thresholds';

/** One row of `plugin_stats` whose `tool` is null: a plugin version as a whole. */
export interface StatsRow {
  readonly plugin: string;
  readonly plugin_version: string;
  readonly reports: number;
  readonly success_rate: number;
  readonly validated: boolean;
}

/** The health of the exact plugin version the site shows. */
export type VersionHealth =
  /** The collector could not be read: nothing is known. */
  | { readonly state: 'not-read' }
  /** Fewer reports than the published minimum: a count, no rate. */
  | { readonly state: 'below-threshold'; readonly reports: number }
  | {
      readonly state: 'measured';
      readonly reports: number;
      readonly successRate: number;
      readonly validated: boolean;
    };

/** The plugin over every version the collector knows: its history, never a verdict. */
export interface AllVersions {
  readonly reports: number;
  readonly versions: number;
}

export interface Health {
  readonly version: VersionHealth;
  /** Null when the collector could not be read. */
  readonly allVersions: AllVersions | null;
}

export interface HealthSnapshot {
  /** ISO time the aggregates were read, or null when they could not be. */
  readonly fetchedAt: string | null;
  readonly rows: readonly StatsRow[];
  /** Why there are no rows, in one line, for the log. */
  readonly problem: string | null;
}

export const FETCH_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 512 * 1024;

export const NOT_READ: Health = { version: { state: 'not-read' }, allVersions: null };

function isStatsRow(value: unknown): value is StatsRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.plugin === 'string' &&
    typeof row.plugin_version === 'string' &&
    (row.tool === undefined || row.tool === null) &&
    typeof row.reports === 'number' &&
    Number.isFinite(row.reports) &&
    typeof row.success_rate === 'number' &&
    row.success_rate >= 0 &&
    row.success_rate <= 1 &&
    typeof row.validated === 'boolean'
  );
}

/** Reads the aggregates; never throws. */
export async function fetchHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<HealthSnapshot> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { fetchedAt: null, rows: [], problem: `HTTP ${response.status}` };
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { fetchedAt: null, rows: [], problem: 'too large' };
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return { fetchedAt: null, rows: [], problem: 'not a list' };
    return { fetchedAt: now().toISOString(), rows: parsed.filter(isStatsRow), problem: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    return { fetchedAt: null, rows: [], problem: `unreachable (${name})` };
  }
}

/**
 * The health of one plugin version, and the plugin's history over every
 * version. Below the published minimum of reports the site shows no rate,
 * whatever the collector computed; the history is a count only.
 */
export function healthOf(
  snapshot: HealthSnapshot,
  plugin: string,
  version: string,
  thresholds: ValidationThresholds,
): Health {
  if (snapshot.fetchedAt === null) return NOT_READ;
  const ofPlugin = snapshot.rows.filter((r) => r.plugin === plugin);
  const allVersions: AllVersions = {
    reports: ofPlugin.reduce((sum, r) => sum + r.reports, 0),
    versions: ofPlugin.length,
  };
  const row = ofPlugin.find((r) => r.plugin_version === version);
  const reports = row?.reports ?? 0;
  if (!row || reports < thresholds.minReports) {
    return { version: { state: 'below-threshold', reports }, allVersions };
  }
  return {
    version: {
      state: 'measured',
      reports,
      successRate: row.success_rate,
      validated: row.validated,
    },
    allVersions,
  };
}

function reportsWord(n: number): string {
  return n === 1 ? '1 report' : `${n} reports`;
}

/** The version's health in one clause: "130 reports of the 200 needed, no rate yet". */
export function healthWords(health: Health, thresholds: ValidationThresholds): string {
  const v = health.version;
  if (v.state === 'not-read') return 'not read (the collector did not answer)';
  if (v.state === 'below-threshold') {
    return v.reports === 0
      ? `no report yet (${thresholds.minReports} needed)`
      : `${reportsWord(v.reports)} of the ${thresholds.minReports} needed, no rate yet`;
  }
  const rate = `${(v.successRate * 100).toFixed(1)} % of ${v.reports} calls worked`;
  return v.validated ? `validated by the community (${rate})` : `not validated (${rate})`;
}

/** The plugin's history in one clause: "203 reports over 2 versions"; empty when not read. */
export function allVersionsWords(health: Health): string {
  const all = health.allVersions;
  if (all === null) return '';
  if (all.versions === 0) return 'no report for any version';
  return `${reportsWord(all.reports)} over ${all.versions === 1 ? '1 version' : `${all.versions} versions`}`;
}
