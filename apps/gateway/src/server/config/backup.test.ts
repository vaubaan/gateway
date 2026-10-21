/**
 * The `backup.*` keys (ADR scheduled-encrypted-backup-to-object-storage, D1, D2): off
 * when absent, the whole bucket block or a refusal naming each missing key, the period
 * and the time of day checked, the secret never quoted and fed to the redactor.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadInstanceConfig, secretValues } from '.';
import { validEnv } from './testing';

const SECRET = 'backup-secret-not-real-0123456789';
const BUCKET_ENV = {
  VAUBAAN_BACKUP_S3_ENDPOINT: 'https://fly.storage.tigris.dev',
  VAUBAAN_BACKUP_S3_REGION: 'auto',
  VAUBAAN_BACKUP_S3_BUCKET: 'acme-backups',
  VAUBAAN_BACKUP_S3_ACCESS_KEY_ID: 'TESTKEY',
  VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
};

function load(extra: Record<string, string | undefined>) {
  return loadInstanceConfig({ env: validEnv(extra) }).config;
}

function problems(extra: Record<string, string | undefined>): string {
  try {
    load(extra);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('expected a ConfigError');
}

describe('backup.* configuration', () => {
  it('is off when no backup.s3.* key is set, even with a schedule', () => {
    expect(load({ VAUBAAN_BACKUP_EVERY: '6h' }).backup).toBeNull();
  });

  it('reads the block with its defaults', () => {
    const backup = load(BUCKET_ENV).backup;
    expect(backup).toEqual({
      s3: {
        endpoint: new URL('https://fly.storage.tigris.dev'),
        region: 'auto',
        bucket: 'acme-backups',
        prefix: '',
        pathStyle: false,
        accessKeyId: 'TESTKEY',
        secretAccessKey: SECRET,
      },
      everySeconds: 86_400,
      atMinutes: 180,
      keep: 0,
    });
  });

  it('reads the schedule, the prefix, path-style and the retention', () => {
    const backup = load({
      ...BUCKET_ENV,
      VAUBAAN_BACKUP_S3_PREFIX: 'tenant/x/',
      VAUBAAN_BACKUP_S3_PATH_STYLE: 'true',
      VAUBAAN_BACKUP_EVERY: '6h',
      VAUBAAN_BACKUP_AT: '01:30',
      VAUBAAN_BACKUP_KEEP: '14',
    }).backup;
    expect(backup).toMatchObject({
      s3: { prefix: 'tenant/x/', pathStyle: true },
      everySeconds: 6 * 3600,
      atMinutes: 90,
      keep: 14,
    });
  });

  it('feeds the secret to the redactor', () => {
    expect(secretValues(load(BUCKET_ENV))).toContain(SECRET);
  });

  it('names every missing key of the block, never the secret', () => {
    const message = problems({ VAUBAAN_BACKUP_S3_BUCKET: 'acme-backups' });
    for (const key of [
      'backup.s3.endpoint',
      'backup.s3.region',
      'backup.s3.access_key_id',
      'backup.s3.secret_access_key',
    ]) {
      expect(message).toContain(key);
    }
    expect(message).not.toContain('backup.s3.bucket:');
  });

  it.each([
    ['http://storage.example.com', 'must use https'],
    ['https://storage.example.com/path', 'origin of the service only'],
    ['https://user:pw@storage.example.com', 'origin of the service only'],
    ['not a url', 'is not a valid URL'],
  ])('refuses the endpoint %s', (endpoint, expected) => {
    expect(problems({ ...BUCKET_ENV, VAUBAAN_BACKUP_S3_ENDPOINT: endpoint })).toContain(expected);
  });

  it('accepts http for a loopback host (a local MinIO, the tests)', () => {
    expect(
      load({ ...BUCKET_ENV, VAUBAAN_BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9000' }).backup?.s3
        .endpoint.host,
    ).toBe('127.0.0.1:9000');
  });

  it.each(['30m', '5h', '7d', '48h'])('refuses the period %s', (every) => {
    expect(problems({ ...BUCKET_ENV, VAUBAAN_BACKUP_EVERY: every })).toContain('backup.every');
  });

  it.each(['3:00', '24:00', '03:60', 'noon'])('refuses the time of day %s', (at) => {
    expect(problems({ ...BUCKET_ENV, VAUBAAN_BACKUP_AT: at })).toContain('backup.at');
  });

  it('refuses a bucket name S3 would refuse, and a prefix starting with /', () => {
    expect(problems({ ...BUCKET_ENV, VAUBAAN_BACKUP_S3_BUCKET: 'Acme_Backups' })).toContain(
      'backup.s3.bucket',
    );
    expect(problems({ ...BUCKET_ENV, VAUBAAN_BACKUP_S3_PREFIX: '/x/' })).toContain(
      'backup.s3.prefix',
    );
  });
});
