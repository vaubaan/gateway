/**
 * Instance configuration persisted in the store (spec §4.3): the Admin-set half of the
 * configuration (IdP, provider apps, telemetry opt-in, retention, bootstrap state). The
 * mounted config file wins on conflict — that precedence is the loader's job (P0.4).
 * Secrets are sealed with `instance_config:<key>` as associated data.
 */

import { withImmediateTransaction } from '../db.ts';
import { openText, sealText } from '../encryptor.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface ConfigRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, plain: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

function secretAd(key: string): string {
  return `instance_config:${key}`;
}

export function createConfigRepo(ctx: RepoContext): ConfigRepo {
  const { db, encryptor } = ctx;
  const getRow = db.prepare<
    [string],
    { value: string | null; secret_blob: Buffer | null; key_version: number | null }
  >('SELECT value, secret_blob, key_version FROM instance_config WHERE key = ?');
  const upsertValue = db.prepare<[string, string, string]>(
    `INSERT INTO instance_config (key, value, secret_blob, key_version, updated_at) VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, secret_blob = NULL, key_version = NULL,
       updated_at = excluded.updated_at`,
  );
  const upsertSecret = db.prepare<[string, Buffer, number, string]>(
    `INSERT INTO instance_config (key, value, secret_blob, key_version, updated_at) VALUES (?, NULL, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = NULL, secret_blob = excluded.secret_blob,
       key_version = excluded.key_version, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare<[string]>('DELETE FROM instance_config WHERE key = ?');
  const allKeys = db.prepare<[], { key: string }>('SELECT key FROM instance_config ORDER BY key');

  return {
    async get(key) {
      return getRow.get(key)?.value ?? null;
    },
    async set(key, value) {
      withImmediateTransaction(db, () => {
        upsertValue.run(key, value, nowIso(ctx));
      });
    },
    async getSecret(key) {
      const row = getRow.get(key);
      if (!row?.secret_blob || row.key_version === null) return null;
      return openText(encryptor, secretAd(key), {
        blob: row.secret_blob,
        keyVersion: row.key_version,
      });
    },
    async setSecret(key, plain) {
      const sealed = await sealText(encryptor, secretAd(key), plain);
      withImmediateTransaction(db, () => {
        upsertSecret.run(key, sealed.blob, sealed.keyVersion, nowIso(ctx));
      });
    },
    async delete(key) {
      return remove.run(key).changes > 0;
    },
    async keys() {
      return allKeys.all().map((r) => r.key);
    },
  };
}
