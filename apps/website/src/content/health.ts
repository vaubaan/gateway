/**
 * Plugin health on the site (website spec §2.4): the collector's two public
 * aggregates, read at request time and refreshed at most hourly
 * (`src/site/live.ts`):
 *
 *   - `plugin_stats` (rows whose `tool` is null): calls, successes, rejected
 *     credentials, success rate and `validated` per plugin version;
 *   - `plugin_instances`: distinct gateways per plugin, version and minor.
 *
 * Each is read on its own: one that fails or answers something malformed
 * makes its figures read "not read", never a guess and never a failed page.
 * Every version with data shows its figures, whatever their number;
 * `validated` is the collector's verdict, shown when true, never a gate.
 */

/** One row of `plugin_stats` whose `tool` is null: a plugin version as a whole. */
export interface StatsRow {
  readonly plugin: string;
  readonly plugin_version: string;
  readonly reports: number;
  readonly successes: number;
  readonly credential_rejections: number;
  /** Null when every report was a rejected credential. */
  readonly success_rate: number | null;
  readonly validated: boolean;
}

/** One row of `plugin_instances`: a version row, a minor row or the plugin row. */
export interface InstancesRow {
  readonly plugin: string;
  readonly plugin_version: string | null;
  readonly plugin_minor: string | null;
  readonly instances: number;
}

/** What one read of the collector gave: its rows, or `null` and why not. */
export interface Read<T> {
  readonly rows: readonly T[] | null;
  readonly problem: string | null;
}

export interface HealthSnapshot {
  /** ISO time of the read, or null when neither aggregate could be read. */
  readonly fetchedAt: string | null;
  readonly stats: Read<StatsRow>;
  readonly instances: Read<InstancesRow>;
}

/** A figure the collector did not give: its aggregate could not be read. */
export const NOT_READ = 'not-read';
export type NotRead = typeof NOT_READ;

/** The figures of one line: a version (`4.0.2`) or a minor (`4.0`). */
export interface LineFigures {
  readonly label: string;
  readonly gateways: number | NotRead;
  readonly calls: number | NotRead;
  /** 0 to 1, rejected credentials left out; null when no call counts. */
  readonly successRate: number | null | NotRead;
  /** The collector's verdict for a version; always false for a minor. */
  readonly validated: boolean;
}

export interface PluginHealth {
  /** Distinct gateways running any version of the plugin over the window. */
  readonly gateways: number | NotRead;
  /** The minor of the version in the repository, then the most recent other minor known. */
  readonly minors: readonly LineFigures[];
  /** The last `MAX_VERSIONS` versions the collector knows, newest first. */
  readonly versions: readonly LineFigures[];
}

export const MAX_VERSIONS = 10;
export const FETCH_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 512 * 1024;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A snapshot with nothing read (the build, an offline render). */
export function unreadSnapshot(problem: string): HealthSnapshot {
  return {
    fetchedAt: null,
    stats: { rows: null, problem },
    instances: { rows: null, problem },
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isStatsRow(value: unknown): value is StatsRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const rate = row.success_rate;
  return (
    typeof row.plugin === 'string' &&
    typeof row.plugin_version === 'string' &&
    SEMVER.test(row.plugin_version) &&
    (row.tool === undefined || row.tool === null) &&
    isCount(row.reports) &&
    isCount(row.successes) &&
    isCount(row.credential_rejections) &&
    (rate === null || (typeof rate === 'number' && rate >= 0 && rate <= 1)) &&
    typeof row.validated === 'boolean'
  );
}

export function isInstancesRow(value: unknown): value is InstancesRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const version = row.plugin_version;
  const minor = row.plugin_minor;
  return (
    typeof row.plugin === 'string' &&
    (version === null || (typeof version === 'string' && SEMVER.test(version))) &&
    (minor === null || (typeof minor === 'string' && /^\d+\.\d+$/.test(minor))) &&
    !(version !== null && minor !== null) &&
    isCount(row.instances)
  );
}

/** Reads one aggregate; never throws. */
export async function fetchRows<T>(
  url: string,
  isRow: (value: unknown) => value is T,
  fetchImpl: typeof fetch = fetch,
): Promise<Read<T>> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { rows: null, problem: `HTTP ${response.status}` };
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { rows: null, problem: 'too large' };
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return { rows: null, problem: 'not a list' };
    return { rows: parsed.filter(isRow), problem: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    return { rows: null, problem: `unreachable (${name})` };
  }
}

/** Reads both aggregates in parallel; never throws. */
export async function fetchHealth(
  urls: { readonly stats: string; readonly instances: string },
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<HealthSnapshot> {
  const [stats, instances] = await Promise.all([
    fetchRows(urls.stats, isStatsRow, fetchImpl),
    fetchRows(urls.instances, isInstancesRow, fetchImpl),
  ]);
  const read = stats.rows !== null || instances.rows !== null;
  return { fetchedAt: read ? now().toISOString() : null, stats, instances };
}

/** `4.0.2` → `4.0`. */
export function minorOf(version: string): string {
  const [major, minor] = version.split('.');
  return `${major}.${minor}`;
}

function semverParts(version: string): [number, number, number, string | null] {
  const m = SEMVER.exec(version);
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0), Number(m?.[3] ?? 0), m?.[4] ?? null];
}

/** Semver order, newest first; a pre-release sorts below its release. Works for minors too. */
export function newestFirst(a: string, b: string): number {
  const [aMajor, aMinor, aPatch, aPre] = semverParts(a.split('.').length === 2 ? `${a}.0` : a);
  const [bMajor, bMinor, bPatch, bPre] = semverParts(b.split('.').length === 2 ? `${b}.0` : b);
  if (aMajor !== bMajor) return bMajor - aMajor;
  if (aMinor !== bMinor) return bMinor - aMinor;
  if (aPatch !== bPatch) return bPatch - aPatch;
  if (aPre === bPre) return 0;
  if (aPre === null) return -1;
  if (bPre === null) return 1;
  return aPre < bPre ? 1 : -1;
}

function rateOf(successes: number, reports: number, rejections: number): number | null {
  const counted = reports - rejections;
  return counted > 0 ? Math.round((successes / counted) * 10_000) / 10_000 : null;
}

/** The health of one plugin, whose version in the repository is `currentVersion`. Pure. */
export function healthOf(
  snapshot: HealthSnapshot,
  plugin: string,
  currentVersion: string,
): PluginHealth {
  const stats = snapshot.stats.rows?.filter((r) => r.plugin === plugin) ?? null;
  const instances = snapshot.instances.rows?.filter((r) => r.plugin === plugin) ?? null;

  const gatewaysOf = (match: (r: InstancesRow) => boolean): number | NotRead =>
    instances === null ? NOT_READ : (instances.find(match)?.instances ?? 0);

  const versionLine = (version: string): LineFigures => {
    const row = stats?.find((r) => r.plugin_version === version);
    return {
      label: version,
      gateways: gatewaysOf((r) => r.plugin_version === version),
      calls: stats === null ? NOT_READ : (row?.reports ?? 0),
      successRate: stats === null ? NOT_READ : (row?.success_rate ?? null),
      validated: row?.validated ?? false,
    };
  };

  const minorLine = (minor: string): LineFigures => {
    const rows = stats?.filter((r) => minorOf(r.plugin_version) === minor) ?? null;
    const sum = (pick: (r: StatsRow) => number): number =>
      (rows ?? []).reduce((total, r) => total + pick(r), 0);
    return {
      label: minor,
      gateways: gatewaysOf((r) => r.plugin_minor === minor),
      calls: rows === null ? NOT_READ : sum((r) => r.reports),
      successRate:
        rows === null
          ? NOT_READ
          : rateOf(
              sum((r) => r.successes),
              sum((r) => r.reports),
              sum((r) => r.credential_rejections),
            ),
      validated: false,
    };
  };

  const known = new Set<string>([
    ...(stats ?? []).map((r) => r.plugin_version),
    ...(instances ?? []).flatMap((r) => (r.plugin_version === null ? [] : [r.plugin_version])),
  ]);
  const versions = [...known].sort(newestFirst).slice(0, MAX_VERSIONS);
  const currentMinor = minorOf(currentVersion);
  const otherMinors = [...new Set([...known].map(minorOf))]
    .filter((minor) => minor !== currentMinor)
    .sort(newestFirst);

  return {
    gateways: gatewaysOf((r) => r.plugin_version === null && r.plugin_minor === null),
    minors: [currentMinor, ...otherMinors.slice(0, 1)].map(minorLine),
    versions: versions.map(versionLine),
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const NOT_READ_WORDS = 'not read';

export function countWords(value: number | NotRead): string {
  return value === NOT_READ ? NOT_READ_WORDS : String(value);
}

/** The calls of a line; a line without any reads "no call yet". */
export function callsWords(value: number | NotRead): string {
  if (value === NOT_READ) return NOT_READ_WORDS;
  return value === 0 ? 'no call yet' : String(value);
}

/** "98.5 %"; "—" when no call counts. */
export function rateWords(value: number | null | NotRead): string {
  if (value === NOT_READ) return NOT_READ_WORDS;
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)} %`;
}

/** "12 gateways run this plugin" over the window. */
export function gatewaysSentence(health: PluginHealth, windowDays: number): string {
  const g = health.gateways;
  if (g === NOT_READ)
    return 'Gateways running this plugin: not read (the collector did not answer).';
  const subject = g === 1 ? '1 gateway runs' : `${g} gateways run`;
  return `${subject} this plugin (over the last ${windowDays} days).`;
}

/** The footnote of the three plugin pages (website spec §2.4). */
export function healthFootnote(windowDays: number): string {
  return `Calls are counted over the last ${windowDays} days from the instances that share plugin health. Gateways are counted over the same window among the instances that also share usage statistics, so they are a lower bound. The success rate leaves out calls refused for a rejected credential: a revoked token is the user's configuration, not the plugin.`;
}
