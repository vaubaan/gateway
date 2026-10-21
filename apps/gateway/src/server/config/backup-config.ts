/**
 * The pure rules of the `backup.*` keys (ADR scheduled-encrypted-backup-to-object-storage,
 * D1, D2): the endpoint, the time of day, the period, the bucket name. The loader
 * reports their problems under the key's path; nothing here quotes a secret.
 */

export const SECONDS_PER_DAY = 86_400;
/** The shortest period between two backups. */
export const MIN_BACKUP_EVERY_SECONDS = 3_600;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const BACKUP_ENDPOINT_PROBLEMS = {
  url: 'is not a valid URL',
  scheme: 'must use https (http is accepted for a loopback host only: localhost, 127.0.0.1, ::1)',
  shape: 'must be the origin of the service only: no user, password, path, query or fragment',
} as const;

export type BackupEndpoint =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly problem: string };

/** An S3 endpoint: an origin, https unless the host is the loopback interface. */
export function parseBackupEndpoint(raw: string): BackupEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: BACKUP_ENDPOINT_PROBLEMS.url };
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, problem: BACKUP_ENDPOINT_PROBLEMS.scheme };
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return { ok: false, problem: BACKUP_ENDPOINT_PROBLEMS.shape };
  }
  return { ok: true, url };
}

/** `HH:MM` (24-hour, UTC) → minutes after midnight, or `null`. */
export function parseTimeOfDay(raw: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** A period the schedule accepts: one hour to one day, dividing a day. */
export function isBackupPeriod(seconds: number): boolean {
  return (
    seconds >= MIN_BACKUP_EVERY_SECONDS &&
    seconds <= SECONDS_PER_DAY &&
    SECONDS_PER_DAY % seconds === 0
  );
}

/** A bucket name as S3-compatible stores accept it (3 to 63 lower-case letters, digits, `.`, `-`). */
export function isBucketName(raw: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw);
}
