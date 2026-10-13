import { withImmediateTransaction } from '../db.ts';
import { openText, sealText } from '../encryptor.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  ConnectionStatus,
  DiscoveredResource,
  Iso,
  Principal,
} from '../types.ts';
import {
  nowIso,
  parseJson,
  placeholders,
  principalColumns,
  principalFromColumns,
  principalPredicate,
  toJson,
  type RepoContext,
} from './context.ts';

export interface CreateConnectionInput {
  readonly provider: string;
  readonly owner: Principal;
  readonly displayName: string;
  /** Clear credential payload (the plugin's serialized credential); sealed by the store
   *  with the connection id as associated data. */
  readonly credential: string | null;
  readonly credentialExpiresAt?: Iso | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ConnectionFilter {
  readonly provider?: string;
  readonly status?: ConnectionStatus;
}

export interface ConnectionsRepo {
  create(input: CreateConnectionInput): Promise<ConnectionRecord>;
  getById(id: string): Promise<ConnectionRecord | null>;
  list(filter?: ConnectionFilter): Promise<ConnectionRecord[]>;
  /** Connections owned by any of the principals (a user and the groups they belong to). */
  listOwnedBy(principals: readonly Principal[]): Promise<ConnectionRecord[]>;
  /** Decrypts the credential in memory; the caller releases it after the upstream call. */
  getCredential(id: string): Promise<string | null>;
  /** Reconnection or refresh: seals the new credential and sets the status back to `active`. */
  setCredential(id: string, credential: string, expiresAt?: Iso | null): Promise<ConnectionRecord>;
  setStatus(id: string, status: ConnectionStatus): Promise<ConnectionRecord>;
  transferOwner(id: string, owner: Principal): Promise<ConnectionRecord>;
  setMetadata(id: string, metadata: Record<string, unknown> | null): Promise<ConnectionRecord>;
  /** Discovery sync: upserts by ref (keeping ids and owner labels), drops refs no longer present. */
  replaceResources(
    connectionId: string,
    resources: readonly DiscoveredResource[],
  ): Promise<ConnectionResourceRecord[]>;
  listResources(connectionId: string): Promise<ConnectionResourceRecord[]>;
  getResource(id: string): Promise<ConnectionResourceRecord | null>;
  setResourceEnv(resourceId: string, env: string | null): Promise<ConnectionResourceRecord>;
}

interface ConnectionRow {
  id: string;
  provider: string;
  owner_kind: string;
  owner_user_id: string | null;
  owner_group_id: string | null;
  display_name: string;
  status: string;
  key_version: number | null;
  credential_expires_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface ResourceRow {
  id: string;
  connection_id: string;
  ref: string;
  env: string | null;
  display_name: string;
  discovered_at: string;
}

const COLUMNS = `id, provider, owner_kind, owner_user_id, owner_group_id, display_name, status,
  key_version, credential_expires_at, metadata_json, created_at, updated_at, revoked_at`;
const RESOURCE_COLUMNS = 'id, connection_id, ref, env, display_name, discovered_at';

function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    owner: principalFromColumns(row.owner_kind, row.owner_user_id, row.owner_group_id),
    displayName: row.display_name,
    status: row.status as ConnectionStatus,
    keyVersion: row.key_version,
    credentialExpiresAt: row.credential_expires_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function resourceToRecord(row: ResourceRow): ConnectionResourceRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    ref: row.ref,
    env: row.env,
    displayName: row.display_name,
    discoveredAt: row.discovered_at,
  };
}

export function createConnectionsRepo(ctx: RepoContext): ConnectionsRepo {
  const { db, encryptor } = ctx;
  const byId = db.prepare<[string], ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections WHERE id = ?`,
  );
  const insert = db.prepare<
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string,
      Buffer | null,
      number | null,
      string | null,
      string | null,
      string,
      string,
    ]
  >(
    `INSERT INTO connections (id, provider, owner_kind, owner_user_id, owner_group_id, display_name,
       status, credential_blob, key_version, credential_expires_at, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const credential = db.prepare<
    [string],
    { credential_blob: Buffer | null; key_version: number | null }
  >('SELECT credential_blob, key_version FROM connections WHERE id = ?');
  const setCredential = db.prepare<[Buffer, number, string | null, string, string]>(
    `UPDATE connections SET credential_blob = ?, key_version = ?, credential_expires_at = ?,
       status = 'active', updated_at = ? WHERE id = ?`,
  );
  const setStatus = db.prepare<[string, string | null, string, string]>(
    `UPDATE connections SET status = ?, revoked_at = COALESCE(?, revoked_at), updated_at = ? WHERE id = ?`,
  );
  const setOwner = db.prepare<[string, string | null, string | null, string, string]>(
    `UPDATE connections SET owner_kind = ?, owner_user_id = ?, owner_group_id = ?, updated_at = ? WHERE id = ?`,
  );
  const setMetadata = db.prepare<[string | null, string, string]>(
    'UPDATE connections SET metadata_json = ?, updated_at = ? WHERE id = ?',
  );
  const resourcesOf = db.prepare<[string], ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM connection_resources WHERE connection_id = ? ORDER BY ref`,
  );
  const resourceById = db.prepare<[string], ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM connection_resources WHERE id = ?`,
  );
  const upsertResource = db.prepare<[string, string, string, string | null, string, string]>(
    `INSERT INTO connection_resources (id, connection_id, ref, env, display_name, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (connection_id, ref) DO UPDATE SET
       display_name = excluded.display_name,
       env = COALESCE(excluded.env, connection_resources.env),
       discovered_at = excluded.discovered_at`,
  );
  const setEnv = db.prepare<[string | null, string]>(
    'UPDATE connection_resources SET env = ? WHERE id = ?',
  );

  function require(id: string): ConnectionRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('connection', id);
    return toRecord(row);
  }

  function requireResource(id: string): ConnectionResourceRecord {
    const row = resourceById.get(id);
    if (!row) throw new NotFoundError('connection_resource', id);
    return resourceToRecord(row);
  }

  return {
    async create(input) {
      const id = ctx.newId();
      const now = nowIso(ctx);
      const owner = principalColumns(input.owner);
      const sealed =
        input.credential !== null ? await sealText(encryptor, id, input.credential) : null;
      insert.run(
        id,
        input.provider,
        owner.kind,
        owner.userId,
        owner.groupId,
        input.displayName,
        'active',
        sealed?.blob ?? null,
        sealed?.keyVersion ?? null,
        input.credentialExpiresAt ?? null,
        toJson(input.metadata),
        now,
        now,
      );
      return require(id);
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async list(filter = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.provider) {
        where.push('provider = ?');
        params.push(filter.provider);
      }
      if (filter.status) {
        where.push('status = ?');
        params.push(filter.status);
      }
      const sql = `SELECT ${COLUMNS} FROM connections ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
      return db
        .prepare<string[], ConnectionRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async listOwnedBy(principals) {
      const pred = principalPredicate(principals, 'owner_user_id', 'owner_group_id');
      return db
        .prepare<string[], ConnectionRow>(
          `SELECT ${COLUMNS} FROM connections WHERE ${pred.sql} ORDER BY created_at`,
        )
        .all(...pred.params)
        .map(toRecord);
    },
    async getCredential(id) {
      const row = credential.get(id);
      if (!row) throw new NotFoundError('connection', id);
      if (!row.credential_blob || row.key_version === null) return null;
      return openText(encryptor, id, { blob: row.credential_blob, keyVersion: row.key_version });
    },
    async setCredential(id, plain, expiresAt = null) {
      const sealed = await sealText(encryptor, id, plain);
      const result = setCredential.run(sealed.blob, sealed.keyVersion, expiresAt, nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('connection', id);
      return require(id);
    },
    async setStatus(id, status) {
      const now = nowIso(ctx);
      const result = setStatus.run(status, status === 'revoked' ? now : null, now, id);
      if (result.changes === 0) throw new NotFoundError('connection', id);
      return require(id);
    },
    async transferOwner(id, owner) {
      const current = require(id);
      if (current.status === 'revoked') {
        throw new InvariantError('a revoked connection cannot change owner');
      }
      const cols = principalColumns(owner);
      setOwner.run(cols.kind, cols.userId, cols.groupId, nowIso(ctx), id);
      return require(id);
    },
    async setMetadata(id, metadata) {
      const result = setMetadata.run(toJson(metadata), nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('connection', id);
      return require(id);
    },
    async replaceResources(connectionId, resources) {
      require(connectionId);
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        const refs = resources.map((r) => r.ref);
        if (refs.length === 0) {
          db.prepare<[string]>('DELETE FROM connection_resources WHERE connection_id = ?').run(
            connectionId,
          );
        } else {
          db.prepare<string[]>(
            `DELETE FROM connection_resources WHERE connection_id = ? AND ref NOT IN (${placeholders(refs.length)})`,
          ).run(connectionId, ...refs);
        }
        for (const r of resources) {
          upsertResource.run(ctx.newId(), connectionId, r.ref, r.env ?? null, r.displayName, now);
        }
      });
      return resourcesOf.all(connectionId).map(resourceToRecord);
    },
    async listResources(connectionId) {
      return resourcesOf.all(connectionId).map(resourceToRecord);
    },
    async getResource(id) {
      const row = resourceById.get(id);
      return row ? resourceToRecord(row) : null;
    },
    async setResourceEnv(resourceId, env) {
      const result = setEnv.run(env, resourceId);
      if (result.changes === 0) throw new NotFoundError('connection_resource', resourceId);
      return requireResource(resourceId);
    },
  };
}
