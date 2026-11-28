/**
 * The store's copies: `restore.*` (docs/handbook/store.md) and the scheduled backup
 * `backup.*` (ADR scheduled-encrypted-backup-to-object-storage).
 */
import { isBackupPeriod, isBucketName, parseBackupEndpoint, parseTimeOfDay } from './backup-config';
import { BYTES_PER_MEGABYTE, type Reader } from './reader';
import { parseRestoreSource, parseSha256 } from './restore-source';
import { envNamesFor, keySpec } from './sources';
import type { BackupConfig, RestoreConfig } from './types';

/**
 * `restore.*` (docs/handbook/store.md): the
 * source is a secret — a problem with it is named, the value never echoed — and the
 * expected SHA-256 is required with it.
 */
export function readRestore(r: Reader): RestoreConfig {
  const maxSpec = keySpec('restore.max_mb');
  let maxMb = r.int(maxSpec);
  if (maxMb > maxSpec.max) {
    r.issues.add(maxSpec.path, `expected an integer from ${maxSpec.min} to ${maxSpec.max}`, [
      ...envNamesFor(maxSpec.path),
    ]);
    maxMb = maxSpec.default;
  }
  const maxBytes = maxMb * BYTES_PER_MEGABYTE;

  const rawFrom = r.string('restore.from');
  let from: RestoreConfig['from'] = null;
  if (rawFrom !== undefined) {
    const parsed = parseRestoreSource(rawFrom);
    if (parsed.ok) from = parsed.source;
    else r.issues.add('restore.from', parsed.problem, envNamesFor('restore.from'));
  }
  const rawSha = r.string('restore.sha256');
  let sha256: string | null = null;
  if (rawSha !== undefined) {
    sha256 = parseSha256(rawSha);
    if (sha256 === null) {
      r.issues.add('restore.sha256', 'expected 64 hexadecimal characters (a SHA-256)', [
        ...envNamesFor('restore.sha256'),
      ]);
    }
  } else if (rawFrom !== undefined) {
    r.issues.add(
      'restore.sha256',
      'required with restore.from: the SHA-256 of the store copy to restore',
      envNamesFor('restore.sha256'),
    );
  }
  return { from, sha256, maxBytes };
}

/** The keys of the bucket: any one set asks for the required ones. */
const BACKUP_BUCKET_REQUIRED = [
  'backup.s3.endpoint',
  'backup.s3.region',
  'backup.s3.bucket',
  'backup.s3.access_key_id',
  'backup.s3.secret_access_key',
] as const;

/**
 * `backup.*` (ADR scheduled-encrypted-backup-to-object-storage, D1, D2): off when no
 * `backup.s3.*` key is set; otherwise the whole bucket block, a period of one hour to
 * a day that divides a day, and a time of day `HH:MM` (UTC). The secret is never quoted.
 */
export function readBackup(r: Reader): BackupConfig | null {
  const s3Paths = [...BACKUP_BUCKET_REQUIRED, 'backup.s3.prefix', 'backup.s3.path_style'];
  if (!s3Paths.some((path) => r.has(path))) return null;
  const values = new Map<string, string>();
  for (const path of BACKUP_BUCKET_REQUIRED) {
    const value = r.string(path)?.trim();
    if (value) values.set(path, value);
    else
      r.issues.add(
        path,
        'required with the other backup.s3.* keys (endpoint, region, bucket, access key id and secret)',
        envNamesFor(path),
      );
  }
  const rawEndpoint = values.get('backup.s3.endpoint');
  let endpoint: URL | undefined;
  if (rawEndpoint !== undefined) {
    const parsed = parseBackupEndpoint(rawEndpoint);
    if (parsed.ok) endpoint = parsed.url;
    else r.issues.add('backup.s3.endpoint', parsed.problem, envNamesFor('backup.s3.endpoint'));
  }
  const bucket = values.get('backup.s3.bucket');
  if (bucket !== undefined && !isBucketName(bucket)) {
    r.issues.add(
      'backup.s3.bucket',
      'expected a bucket name: 3 to 63 lower-case letters, digits, dots and hyphens',
      envNamesFor('backup.s3.bucket'),
    );
  }
  const prefix = r.string('backup.s3.prefix')?.trim() ?? '';
  if (prefix.startsWith('/') || prefix.length > 512) {
    r.issues.add(
      'backup.s3.prefix',
      'must not start with "/" and must be at most 512 characters',
      envNamesFor('backup.s3.prefix'),
    );
  }
  const pathStyle = r.bool(keySpec('backup.s3.path_style'));
  const everySpec = keySpec('backup.every');
  const everySeconds = r.duration(everySpec);
  if (!isBackupPeriod(everySeconds)) {
    r.issues.add(
      everySpec.path,
      'expected a period from 1h to 24h that divides a day (1h, 2h, 3h, 4h, 6h, 8h, 12h, 24h)',
      envNamesFor(everySpec.path),
    );
  }
  const atSpec = keySpec('backup.at');
  const atText = r.text(atSpec);
  const atMinutes = parseTimeOfDay(atText);
  if (atMinutes === null) {
    r.issues.add(atSpec.path, `expected a time of day HH:MM (UTC), got "${atText}"`, [
      ...envNamesFor(atSpec.path),
    ]);
  }
  const keepSpec = keySpec('backup.keep');
  const keep = r.int(keepSpec);
  if (keep > keepSpec.max) {
    r.issues.add(keepSpec.path, `expected an integer from ${keepSpec.min} to ${keepSpec.max}`, [
      ...envNamesFor(keepSpec.path),
    ]);
  }
  const region = values.get('backup.s3.region');
  const accessKeyId = values.get('backup.s3.access_key_id');
  const secretAccessKey = r.string('backup.s3.secret_access_key');
  if (
    !endpoint ||
    !region ||
    !bucket ||
    !isBucketName(bucket) ||
    !accessKeyId ||
    !secretAccessKey ||
    atMinutes === null ||
    !isBackupPeriod(everySeconds)
  ) {
    return null;
  }
  return {
    s3: { endpoint, region, bucket, prefix, pathStyle, accessKeyId, secretAccessKey },
    everySeconds,
    atMinutes,
    keep: Math.min(keep, keepSpec.max),
  };
}
