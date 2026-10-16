/**
 * Plugin health on the site (website spec §2.4): the collector's public
 * aggregates, read once at build time. The collector is optional and may be
 * down or not deployed: any failure, a malformed answer, or fewer reports
 * than the threshold reads "not enough reports yet" — never a rate, never a
 * failed build.
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

export type Health =
  | { readonly state: 'not-enough-reports'; readonly reports: number | null }
  | {
      readonly state: 'measured';
      readonly reports: number;
      readonly successRate: number;
      readonly validated: boolean;
    };

export interface HealthSnapshot {
  /** ISO time the aggregates were read, or null when they could not be. */
  readonly fetchedAt: string | null;
  readonly rows: readonly StatsRow[];
  /** Why there are no rows, in one line, for the build log. */
  readonly problem: string | null;
}

export const FETCH_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 512 * 1024;

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
 * The health of one plugin version. Below the published minimum of reports
 * the site shows no rate, whatever the collector computed.
 */
export function healthOf(
  snapshot: HealthSnapshot,
  plugin: string,
  version: string,
  thresholds: ValidationThresholds,
): Health {
  const row = snapshot.rows.find((r) => r.plugin === plugin && r.plugin_version === version);
  if (!row) return { state: 'not-enough-reports', reports: snapshot.fetchedAt ? 0 : null };
  if (row.reports < thresholds.minReports) {
    return { state: 'not-enough-reports', reports: row.reports };
  }
  return {
    state: 'measured',
    reports: row.reports,
    successRate: row.success_rate,
    validated: row.validated,
  };
}

export function healthWords(health: Health): string {
  if (health.state === 'not-enough-reports') return 'not enough reports yet';
  const rate = `${(health.successRate * 100).toFixed(1)} % of ${health.reports} calls worked`;
  return health.validated ? `validated by the community (${rate})` : `not validated (${rate})`;
}
