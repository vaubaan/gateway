/**
 * The signers an instance trusts for its private plugins (migration 0042; ADR
 * plugin-signature-sets-the-trust-level): an ed25519 public key, named. The key id is the
 * sha256 of the key's SPKI DER, the one a signature names.
 */

import type { Iso } from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface PluginSignerRecord {
  readonly keyId: string;
  readonly name: string;
  readonly publicKeyPem: string;
  readonly addedAt: Iso;
  readonly addedBy: string;
}

export interface PluginSignersRepo {
  list(): Promise<readonly PluginSignerRecord[]>;
  get(keyId: string): Promise<PluginSignerRecord | null>;
  /** `false` when the key or the name is already there. */
  add(signer: Omit<PluginSignerRecord, 'addedAt'>): Promise<boolean>;
  /** Whether a row was removed. */
  remove(keyId: string): Promise<boolean>;
}

interface Row {
  key_id: string;
  name: string;
  public_key_pem: string;
  added_at: string;
  added_by: string;
}

const toRecord = (row: Row): PluginSignerRecord => ({
  keyId: row.key_id,
  name: row.name,
  publicKeyPem: row.public_key_pem,
  addedAt: row.added_at,
  addedBy: row.added_by,
});

export function createPluginSignersRepo(ctx: RepoContext): PluginSignersRepo {
  const { db } = ctx;
  const all = db.prepare<[], Row>('SELECT * FROM plugin_signers ORDER BY name');
  const one = db.prepare<[string], Row>('SELECT * FROM plugin_signers WHERE key_id = ?');
  const insert = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO plugin_signers (key_id, name, public_key_pem, added_at, added_by)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const remove = db.prepare<[string]>('DELETE FROM plugin_signers WHERE key_id = ?');
  return {
    async list() {
      return all.all().map(toRecord);
    },
    async get(keyId) {
      const row = one.get(keyId);
      return row === undefined ? null : toRecord(row);
    },
    async add(signer) {
      return (
        insert.run(signer.keyId, signer.name, signer.publicKeyPem, nowIso(ctx), signer.addedBy)
          .changes > 0
      );
    },
    async remove(keyId) {
      return remove.run(keyId).changes > 0;
    },
  };
}
