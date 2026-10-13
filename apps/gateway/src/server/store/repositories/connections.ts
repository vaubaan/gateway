import { isUnavailableConnectionStatus } from '@vaubaan/gateway-core';

import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText } from '../encryptor.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  ConnectionStatus,
  DiscoveredResource,
  Iso,
  Principal,
  ProviderGrantOutcome,
} from '../types.ts';
import { PROVIDER_GRANT_OUTCOMES, RESOURCE_ENV_SOURCES } from '../types.ts';
import {
  nowIso,
  parseEnum,
  parseJsonObject,
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

/**
 * What the operator's reassignment did. `not-ownerless` and `owner-group-empty` are
 * decided inside the write transaction: nothing was written.
 */
export type AssignOwnerlessResult =
  | {
      readonly outcome: 'assigned';
      /** The connection as it was read inside the transaction, before the write. */
      readonly previous: ConnectionRecord;
      readonly connection: ConnectionRecord;
    }
  | { readonly outcome: 'not-ownerless' | 'owner-group-empty' };

export interface ConnectionsRepo {
  create(input: CreateConnectionInput): Promise<ConnectionRecord>;
  getById(id: string): Promise<ConnectionRecord | null>;
  list(filter?: ConnectionFilter): Promise<ConnectionRecord[]>;
  /** Connections owned by any of the principals (a user and the groups they belong to). */
  listOwnedBy(principals: readonly Principal[]): Promise<ConnectionRecord[]>;
  /** Decrypts the credential in memory; the caller releases it after the upstream call. */
  getCredential(id: string): Promise<string | null>;
  transferOwner(id: string, owner: Principal): Promise<ConnectionRecord>;
  /**
   * The operator's reassignment (spec §2.3), with its rule inside the write: in one
   * transaction, the connection must be ownerless at that instant (`unowned`, or not
   * revoked with an owner group that has no member — the predicate of `listOwnerless`)
   * and a new owner group must have a member; then the owner is written and an
   * `unowned` connection is `active` again (an `expired` one stays `expired`).
   * `NotFoundError` when the connection does not exist.
   */
  assignOwnerlessTo(id: string, owner: Principal): Promise<AssignOwnerlessResult>;
  /**
   * `active` → `unowned` for every connection nobody owns any more (spec §2.3): its
   * owner group has no member left, or its owner user was deactivated. Returns the
   * connections that changed. Called after every membership removal and every
   * deactivation; a connection that is `expired` stays so.
   */
  markOwnerlessUnowned(): Promise<ConnectionRecord[]>;
  /**
   * The connections nobody owns any more: `unowned`, or not revoked with an owner group
   * that has no member or an owner user who is not active (an `expired` one cannot be
   * `unowned` at the same time). What the operator may reassign.
   */
  listOwnerless(): Promise<ConnectionRecord[]>;
  setMetadata(id: string, metadata: Record<string, unknown> | null): Promise<ConnectionRecord>;
  listResources(connectionId: string): Promise<ConnectionResourceRecord[]>;
  getResource(id: string): Promise<ConnectionResourceRecord | null>;
  setResourceEnv(resourceId: string, env: string | null): Promise<ConnectionResourceRecord>;

  /**
   * Reconnection by an owner: new credential, status `active`. Only an `active` or an
   * `expired` connection is reconnected: revocation is terminal, and nobody reconnects an
   * `unowned` connection until an owner is reassigned (spec §2.3). Returns false when
   * nothing was written.
   */
  reconnect(id: string, credential: string, expiresAt?: Iso | null): Promise<boolean>;
  /**
   * Token refresh: seals the new credential only while the connection still serves calls
   * (`active` or `unowned`, see `isUnavailableConnectionStatus`) and leaves the status
   * alone, so a refresh racing a revocation never resurrects the connection. Returns
   * false when nothing was written.
   */
  refreshCredential(id: string, credential: string, expiresAt?: Iso | null): Promise<boolean>;
  /**
   * The provider rejected the credential and the refresh failed: a serving connection
   * (`active` or `unowned`) → `expired`. Conditional, so it never downgrades a `revoked`
   * connection. An `unowned` connection that expires stays ownerless (`listOwnerless`):
   * the operator reassigns an owner, who reconnects. Returns false when the connection
   * was not serving.
   */
  markExpired(id: string): Promise<boolean>;
  /** Terminal revocation: status `revoked`, `revoked_at` set, the credential blob erased. */
  revoke(id: string): Promise<ConnectionRecord>;
  /**
   * Records what became of the provider-side grant of a connection that is
   * already revoked. Written once: a row that is not revoked, or that already
   * holds an outcome, is left alone and `null` is returned.
   */
  recordProviderGrant(id: string, outcome: ProviderGrantOutcome): Promise<ConnectionRecord | null>;
  /**
   * Discovery merge (spec §0 "Resource"): provider facts are refreshed, owner edits are
   * kept, nothing is deleted.
   *  - a new ref is inserted; an `env` the plugin returns marks the label `plugin`-set;
   *  - a known ref keeps its id, its owner label, its owner metadata, its `hidden` flag and
   *    its display name once the owner renamed it; the discovered metadata replaces the
   *    previous provider facts; a plugin-set `env` always follows the plugin;
   *  - a ref the discovery no longer returns is marked stale (`staleSince`), and a stale
   *    ref that comes back is cleared.
   */
  syncDiscoveredResources(
    connectionId: string,
    resources: readonly DiscoveredResource[],
  ): Promise<ConnectionResourceRecord[]>;
  /** Owner rename; `null` hands the name back to discovery (the current name stays until then). */
  setResourceDisplayName(
    resourceId: string,
    displayName: string | null,
  ): Promise<ConnectionResourceRecord>;
  setResourceHidden(resourceId: string, hidden: boolean): Promise<ConnectionResourceRecord>;
  /** Owner edits over the discovered metadata; `null` clears them. */
  setResourceOwnerMetadata(
    resourceId: string,
    metadata: Record<string, unknown> | null,
  ): Promise<ConnectionResourceRecord>;
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
  provider_grant: string | null;
}

interface ResourceRow {
  id: string;
  connection_id: string;
  ref: string;
  env: string | null;
  display_name: string;
  discovered_at: string;
  metadata_json: string | null;
  owner_metadata_json: string | null;
  env_source: string;
  display_name_edited: number;
  hidden: number;
  stale_since: string | null;
}

const COLUMNS = `id, provider, owner_kind, owner_user_id, owner_group_id, display_name, status,
  key_version, credential_expires_at, metadata_json, created_at, updated_at, revoked_at,
  provider_grant`;
const RESOURCE_COLUMNS = `id, connection_id, ref, env, display_name, discovered_at, metadata_json,
  owner_metadata_json, env_source, display_name_edited, hidden, stale_since`;

/** Every status of the schema's `CHECK`; a status added to the union fails to compile here. */
const CONNECTION_STATUSES = Object.keys({
  active: true,
  expired: true,
  revoked: true,
  unowned: true,
} satisfies Record<ConnectionStatus, true>) as ConnectionStatus[];

/** The statuses whose credential is still used for calls: gateway-core decides, not this file. */
const SERVING_STATUSES: readonly ConnectionStatus[] = CONNECTION_STATUSES.filter(
  (status) => !isUnavailableConnectionStatus(status),
);

/** The statuses an owner may reconnect from (spec §2.3): neither `revoked` nor `unowned`. */
const RECONNECTABLE_STATUSES: readonly ConnectionStatus[] = ['active', 'expired'];

function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    owner: principalFromColumns(row.owner_kind, row.owner_user_id, row.owner_group_id),
    displayName: row.display_name,
    status: parseEnum(CONNECTION_STATUSES, row.status, 'connections.status'),
    keyVersion: row.key_version,
    credentialExpiresAt: row.credential_expires_at,
    metadata: parseJsonObject(row.metadata_json, 'connections.metadata_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    providerGrant:
      row.provider_grant === null
        ? null
        : parseEnum(PROVIDER_GRANT_OUTCOMES, row.provider_grant, 'connections.provider_grant'),
  };
}

function resourceToRecord(row: ResourceRow): ConnectionResourceRecord {
  const discovered = parseJsonObject(row.metadata_json, 'connection_resources.metadata_json');
  const ownerMetadata = parseJsonObject(
    row.owner_metadata_json,
    'connection_resources.owner_metadata_json',
  );
  return {
    id: row.id,
    connectionId: row.connection_id,
    ref: row.ref,
    env: row.env,
    displayName: row.display_name,
    discoveredAt: row.discovered_at,
    envSource: parseEnum(RESOURCE_ENV_SOURCES, row.env_source, 'connection_resources.env_source'),
    metadata: discovered || ownerMetadata ? { ...discovered, ...ownerMetadata } : null,
    ownerMetadata,
    displayNameEdited: row.display_name_edited === 1,
    hidden: row.hidden === 1,
    staleSince: row.stale_since,
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
  const credentialStmt = db.prepare<
    [string],
    { credential_blob: Buffer | null; key_version: number | null }
  >('SELECT credential_blob, key_version FROM connections WHERE id = ?');
  const setOwnerStmt = db.prepare<[string, string | null, string | null, string, string]>(
    `UPDATE connections SET owner_kind = ?, owner_user_id = ?, owner_group_id = ?, updated_at = ? WHERE id = ?`,
  );
  const setMetadataStmt = db.prepare<[string | null, string, string]>(
    'UPDATE connections SET metadata_json = ?, updated_at = ? WHERE id = ?',
  );
  const resourcesOf = db.prepare<[string], ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM connection_resources WHERE connection_id = ? ORDER BY ref`,
  );
  const resourceById = db.prepare<[string], ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM connection_resources WHERE id = ?`,
  );
  const setEnv = db.prepare<[string | null, string]>(
    "UPDATE connection_resources SET env = ?, env_source = 'owner' WHERE id = ?",
  );
  const reconnectStmt = db.prepare<[Buffer, number, string | null, string, string, ...string[]]>(
    `UPDATE connections SET credential_blob = ?, key_version = ?, credential_expires_at = ?,
       status = 'active', updated_at = ?
     WHERE id = ? AND status IN (${placeholders(RECONNECTABLE_STATUSES.length)})`,
  );
  const refreshCredentialStmt = db.prepare<
    [Buffer, number, string | null, string, string, ...string[]]
  >(
    `UPDATE connections SET credential_blob = ?, key_version = ?, credential_expires_at = ?,
       updated_at = ? WHERE id = ? AND status IN (${placeholders(SERVING_STATUSES.length)})`,
  );
  const markExpiredStmt = db.prepare<[string, string, ...string[]]>(
    `UPDATE connections SET status = 'expired', updated_at = ?
     WHERE id = ? AND status IN (${placeholders(SERVING_STATUSES.length)})`,
  );
  const assignOwnerStmt = db.prepare<[string, string | null, string | null, string, string]>(
    `UPDATE connections SET owner_kind = ?, owner_user_id = ?, owner_group_id = ?,
       status = CASE WHEN status = 'unowned' THEN 'active' ELSE status END, updated_at = ?
     WHERE id = ?`,
  );
  // Nobody owns it: its owner group has no member, or its owner user is not active
  // (deactivated by an operator: they hold nothing, so they cannot share or reconnect).
  const NO_MEMBER = `((owner_kind = 'group' AND NOT EXISTS (
       SELECT 1 FROM group_members gm WHERE gm.group_id = connections.owner_group_id))
     OR (owner_kind = 'user' AND NOT EXISTS (
       SELECT 1 FROM users u WHERE u.id = connections.owner_user_id AND u.status = 'active')))`;
  const ownerlessActive = db.prepare<[], ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections WHERE status = 'active' AND ${NO_MEMBER} ORDER BY created_at`,
  );
  const markUnownedStmt = db.prepare<[string, string]>(
    "UPDATE connections SET status = 'unowned', updated_at = ? WHERE id = ? AND status = 'active'",
  );
  const ownerless = db.prepare<[], ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections
     WHERE status = 'unowned' OR (status <> 'revoked' AND ${NO_MEMBER}) ORDER BY created_at`,
  );
  const isOwnerless = db.prepare<[string], { found: number }>(
    `SELECT 1 AS found FROM connections
     WHERE id = ? AND (status = 'unowned' OR (status <> 'revoked' AND ${NO_MEMBER}))`,
  );
  const groupHasMember = db.prepare<[string], { found: number }>(
    'SELECT 1 AS found FROM group_members WHERE group_id = ? LIMIT 1',
  );
  const revokeStmt = db.prepare<[string, string, string]>(
    `UPDATE connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
       credential_blob = NULL, key_version = NULL, credential_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const providerGrantStmt = db.prepare<[string, string]>(
    `UPDATE connections SET provider_grant = ?
     WHERE id = ? AND status = 'revoked' AND provider_grant IS NULL`,
  );
  const resourceByRef = db.prepare<[string, string], ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM connection_resources WHERE connection_id = ? AND ref = ?`,
  );
  const insertDiscovered = db.prepare<
    [string, string, string, string | null, string, string, string | null, string]
  >(
    `INSERT INTO connection_resources (id, connection_id, ref, env, display_name, discovered_at,
       metadata_json, env_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateDiscovered = db.prepare<
    [string | null, string, string, string, string | null, string]
  >(
    `UPDATE connection_resources SET env = ?, env_source = ?, display_name = ?, discovered_at = ?,
       metadata_json = ?, stale_since = NULL WHERE id = ?`,
  );
  const markStale = db.prepare<[string, string]>(
    'UPDATE connection_resources SET stale_since = COALESCE(stale_since, ?) WHERE id = ?',
  );
  const setDisplayNameStmt = db.prepare<[string, number, string]>(
    'UPDATE connection_resources SET display_name = ?, display_name_edited = ? WHERE id = ?',
  );
  const setHiddenStmt = db.prepare<[number, string]>(
    'UPDATE connection_resources SET hidden = ? WHERE id = ?',
  );
  const setOwnerMetadataStmt = db.prepare<[string | null, string]>(
    'UPDATE connection_resources SET owner_metadata_json = ? WHERE id = ?',
  );

  function requireConnection(id: string): ConnectionRecord {
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
      return requireConnection(id);
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
      const row = credentialStmt.get(id);
      if (!row) throw new NotFoundError('connection', id);
      return openSealedColumn(encryptor, id, row.credential_blob, row.key_version);
    },
    async transferOwner(id, owner) {
      const cols = principalColumns(owner);
      const now = nowIso(ctx);
      // Check and write in one transaction: a revocation between the two is impossible.
      return withImmediateTransaction(db, () => {
        const current = requireConnection(id);
        if (current.status === 'revoked') {
          throw new InvariantError('a revoked connection cannot change owner');
        }
        setOwnerStmt.run(cols.kind, cols.userId, cols.groupId, now, id);
        return requireConnection(id);
      });
    },
    async setMetadata(id, metadata) {
      const result = setMetadataStmt.run(toJson(metadata), nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('connection', id);
      return requireConnection(id);
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
    async reconnect(id, plain, expiresAt = null) {
      const sealed = await sealText(encryptor, id, plain);
      const result = reconnectStmt.run(
        sealed.blob,
        sealed.keyVersion,
        expiresAt,
        nowIso(ctx),
        id,
        ...RECONNECTABLE_STATUSES,
      );
      return result.changes > 0;
    },
    async refreshCredential(id, plain, expiresAt = null) {
      const sealed = await sealText(encryptor, id, plain);
      const result = refreshCredentialStmt.run(
        sealed.blob,
        sealed.keyVersion,
        expiresAt,
        nowIso(ctx),
        id,
        ...SERVING_STATUSES,
      );
      return result.changes > 0;
    },
    async markExpired(id) {
      return markExpiredStmt.run(nowIso(ctx), id, ...SERVING_STATUSES).changes > 0;
    },
    async assignOwnerlessTo(id, owner) {
      const cols = principalColumns(owner);
      const now = nowIso(ctx);
      // The rule and the write in one transaction: no member can join the owner group,
      // and none can leave the new one, between the check and the write.
      return withImmediateTransaction(db, (): AssignOwnerlessResult => {
        const previous = requireConnection(id);
        if (!isOwnerless.get(id)) return { outcome: 'not-ownerless' };
        if (owner.kind === 'group' && !groupHasMember.get(owner.id)) {
          return { outcome: 'owner-group-empty' };
        }
        assignOwnerStmt.run(cols.kind, cols.userId, cols.groupId, now, id);
        return { outcome: 'assigned', previous, connection: requireConnection(id) };
      });
    },
    async markOwnerlessUnowned() {
      const now = nowIso(ctx);
      // Read and write in one transaction: a member joining between the two is impossible.
      return withImmediateTransaction(db, () => {
        const changed: ConnectionRecord[] = [];
        for (const row of ownerlessActive.all()) {
          if (markUnownedStmt.run(now, row.id).changes > 0) changed.push(requireConnection(row.id));
        }
        return changed;
      });
    },
    async listOwnerless() {
      return ownerless.all().map(toRecord);
    },
    async revoke(id) {
      const now = nowIso(ctx);
      const result = revokeStmt.run(now, now, id);
      if (result.changes === 0) throw new NotFoundError('connection', id);
      return requireConnection(id);
    },
    async recordProviderGrant(id, outcome) {
      if (!PROVIDER_GRANT_OUTCOMES.includes(outcome)) {
        throw new InvariantError(`unknown provider grant outcome '${String(outcome)}'`);
      }
      return providerGrantStmt.run(outcome, id).changes === 1 ? requireConnection(id) : null;
    },
    async syncDiscoveredResources(connectionId, resources) {
      requireConnection(connectionId);
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        const seen = new Set<string>();
        for (const r of resources) {
          if (seen.has(r.ref)) continue; // a plugin listing a ref twice: the first one wins
          seen.add(r.ref);
          const pluginEnv = r.env ?? null;
          const metadataJson = toJson(r.metadata ?? null);
          const existing = resourceByRef.get(connectionId, r.ref);
          if (!existing) {
            insertDiscovered.run(
              ctx.newId(),
              connectionId,
              r.ref,
              pluginEnv,
              r.displayName,
              now,
              metadataJson,
              pluginEnv !== null ? 'plugin' : 'owner',
            );
            continue;
          }
          updateDiscovered.run(
            // A label the plugin sets follows the plugin; otherwise the owner's label stays
            // (and becomes editable again if the plugin used to set it).
            pluginEnv ?? existing.env,
            pluginEnv !== null ? 'plugin' : 'owner',
            existing.display_name_edited === 1 ? existing.display_name : r.displayName,
            now,
            metadataJson,
            existing.id,
          );
        }
        for (const row of resourcesOf.all(connectionId)) {
          if (!seen.has(row.ref)) markStale.run(now, row.id);
        }
      });
      return resourcesOf.all(connectionId).map(resourceToRecord);
    },
    async setResourceDisplayName(resourceId, displayName) {
      const current = requireResource(resourceId);
      setDisplayNameStmt.run(
        displayName ?? current.displayName,
        displayName === null ? 0 : 1,
        resourceId,
      );
      return requireResource(resourceId);
    },
    async setResourceHidden(resourceId, hidden) {
      const result = setHiddenStmt.run(hidden ? 1 : 0, resourceId);
      if (result.changes === 0) throw new NotFoundError('connection_resource', resourceId);
      return requireResource(resourceId);
    },
    async setResourceOwnerMetadata(resourceId, metadata) {
      const result = setOwnerMetadataStmt.run(toJson(metadata), resourceId);
      if (result.changes === 0) throw new NotFoundError('connection_resource', resourceId);
      return requireResource(resourceId);
    },
  };
}
