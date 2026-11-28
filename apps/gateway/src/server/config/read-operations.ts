/**
 * How the instance runs: `accounts.refresh_interval`, `limits.*`, `ops.token`,
 * `updates.*`, `docs.url`, `telemetry.level` and `log.level`.
 */
import { isTelemetryLevel, TELEMETRY_LEVELS, type TelemetryLevel } from '@vaubaan/telemetry';

import type { Reader } from './reader';
import type { EnvSource } from './secret-refs';
import { RETIRED_LIMITS_CONNECTIONS_ENV, RETIRED_LIMITS_CONNECTIONS_KEY } from './retired-keys';
import { envNamesFor, keySpec } from './sources';
import { getPath, type RawTree } from './tree';
import {
  type DocsConfig,
  isLogLevel,
  LOG_LEVELS,
  type LimitsConfig,
  type LogLevel,
  type UpdatesConfig,
} from './types';

const MIN_OPS_TOKEN_LENGTH = keySpec('ops.token').minLength;
const DEFAULT_LOG_LEVEL: LogLevel = keySpec('log.level').default;

/** The shortest `accounts.refresh_interval` but 0: the services' rate limits come first. */
export const MIN_REFRESH_INTERVAL_SECONDS = 15 * 60;

/**
 * `accounts.refresh_interval`: a duration from 15 minutes to a day, or `0` (the automatic
 * refresh off).
 */
export function readRefreshInterval(r: Reader, raw: RawTree): number {
  const spec = keySpec('accounts.refresh_interval');
  // `0` in the file is a number, in the environment a string.
  const value = getPath(raw, spec.path);
  if (value === 0 || (typeof value === 'string' && value.trim() === '0')) return 0;
  const seconds = r.duration(spec);
  if (seconds < MIN_REFRESH_INTERVAL_SECONDS || seconds > spec.maxSeconds) {
    r.issues.add(
      spec.path,
      'expected 0 (off) or a duration from 15m to 24h',
      envNamesFor(spec.path),
    );
  }
  return seconds;
}

/**
 * `limits.*` (spec §4.3 bis): each a positive whole number, absent unlimited. A
 * ceiling under the current count is accepted: nothing is cut, additions are refused.
 */
export function readLimits(r: Reader): LimitsConfig {
  return {
    users: r.optionalInt(keySpec('limits.users')),
    accounts: r.optionalInt(keySpec('limits.accounts')),
    activeMissions: r.optionalInt(keySpec('limits.active_missions')),
  };
}

/**
 * The old name of the accounts ceiling (`limits.connections`,
 * `VAUBAAN_LIMITS_CONNECTIONS`) is refused: ignored, it would lift the ceiling.
 */
export function refuseRetiredLimitKeys(r: Reader, raw: RawTree, env: EnvSource): void {
  const variables =
    env[RETIRED_LIMITS_CONNECTIONS_ENV] !== undefined ? [RETIRED_LIMITS_CONNECTIONS_ENV] : [];
  if (getPath(raw, RETIRED_LIMITS_CONNECTIONS_KEY) === undefined && variables.length === 0) return;
  r.issues.add(
    RETIRED_LIMITS_CONNECTIONS_KEY,
    'is retired: write the same ceiling as limits.accounts (VAUBAAN_LIMITS_ACCOUNTS)',
    variables,
  );
}

/** `updates.*`: the versions check, on by default, and its https feed. */
export function readUpdates(r: Reader): UpdatesConfig | undefined {
  const check = r.bool(keySpec('updates.check'));
  const feed = keySpec('updates.feed_url');
  const feedUrl = r.url(feed.path, { fallback: feed.default, https: feed.https });
  return feedUrl ? { check, feedUrl } : undefined;
}

/** `docs.url`: the https docs root the interface links to, trailing slash stripped. */
export function readDocs(r: Reader): DocsConfig | undefined {
  const spec = keySpec('docs.url');
  const url = r.url(spec.path, { fallback: spec.default, https: spec.https });
  if (!url) return undefined;
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { url };
}

/** `ops.token`: optional; when set, long enough to resist guessing. */
export function readOpsToken(r: Reader): string | null {
  const path = 'ops.token';
  const token = r.string(path) ?? null;
  if (token !== null && token.length < MIN_OPS_TOKEN_LENGTH) {
    r.issues.add(
      path,
      `must be at least ${MIN_OPS_TOKEN_LENGTH} characters long`,
      envNamesFor(path),
    );
    return null;
  }
  return token;
}

export function readTelemetryLevel(r: Reader): TelemetryLevel {
  const fallback: TelemetryLevel = 'usage-stats';
  const level = r.string('telemetry.level', { fallback }) ?? fallback;
  if (isTelemetryLevel(level)) return level;
  r.issues.add(
    'telemetry.level',
    `expected one of ${TELEMETRY_LEVELS.join(', ')}, got "${level}"`,
    [...envNamesFor('telemetry.level')],
  );
  return fallback;
}

export function readLogLevel(r: Reader): LogLevel {
  const level = r.string('log.level', { fallback: DEFAULT_LOG_LEVEL }) ?? DEFAULT_LOG_LEVEL;
  if (isLogLevel(level)) return level;
  r.issues.add('log.level', `expected one of ${LOG_LEVELS.join(', ')}, got "${level}"`, [
    ...envNamesFor('log.level'),
  ]);
  return DEFAULT_LOG_LEVEL;
}
