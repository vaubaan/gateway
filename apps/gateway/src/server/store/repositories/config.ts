/**
 * Instance configuration persisted in the store (spec §4.3): the Admin-set half of the
 * configuration (IdP, provider apps, telemetry opt-in, retention, bootstrap state). The
 * mounted config file wins on conflict — that precedence is the loader's job.
 * Secrets are sealed with `instance_config:<key>` as associated data.
 */

import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText } from '../encryptor.ts';
import { InvariantError } from '../errors.ts';
import { nowIso, type RepoContext } from './context.ts';

/** One change of `ConfigRepo.apply`: a clear value, a sealed secret, or a removal. */
export type ConfigWrite =
  | { readonly kind: 'value'; readonly key: string; readonly value: string }
  | { readonly kind: 'secret'; readonly key: string; readonly plain: string }
  | { readonly kind: 'delete'; readonly key: string };

export interface ConfigRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, plain: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  /**
   * Applies every write in one transaction, in order: all of them or none. For
   * settings spread over several keys (the IdP, a provider app), where a
   * half-saved set would pair one value with another's secret.
   */
  apply(writes: readonly ConfigWrite[]): Promise<void>;
  keys(): Promise<string[]>;
}

export function secretAd(key: string): string {
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
      if (!row) return null;
      return openSealedColumn(encryptor, secretAd(key), row.secret_blob, row.key_version);
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
    async apply(writes) {
      // Sealing is asynchronous and the transaction is not: seal first, write after.
      const sealed = new Map<string, Awaited<ReturnType<typeof sealText>>>();
      for (const write of writes) {
        if (write.kind === 'secret') {
          sealed.set(write.key, await sealText(encryptor, secretAd(write.key), write.plain));
        }
      }
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        for (const write of writes) {
          if (write.kind === 'delete') {
            remove.run(write.key);
          } else if (write.kind === 'value') {
            upsertValue.run(write.key, write.value, now);
          } else {
            const blob = sealed.get(write.key);
            if (!blob) throw new InvariantError(`instance_config: '${write.key}' was not sealed`);
            upsertSecret.run(write.key, blob.blob, blob.keyVersion, now);
          }
        }
      });
    },
    async keys() {
      return allKeys.all().map((r) => r.key);
    },
  };
}
