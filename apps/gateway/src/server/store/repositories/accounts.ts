import { isUnavailableAccountStatus } from '@vaubaan/gateway-core';

import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText } from '../encryptor.ts';
import { HostAccountTakenError, InvariantError, NotFoundError } from '../errors.ts';
import type {
  AccountRecord,
  AccountResourceRecord,
  AccountStatus,
  DiscoveredResource,
  Iso,
  Principal,
  ServiceGrantOutcome,
} from '../types.ts';
import { SERVICE_GRANT_OUTCOMES, RESOURCE_ENV_SOURCES } from '../types.ts';
import { effectiveResourceEnv } from '../resource-env.ts';
import { toIso } from '../clock.ts';
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

/**
 * How long a resource row stays safe from being marked stale after it was first seen
 * (inserted, or seen again after it was stale): a service may list a resource a while
 * after creating it (Miro's board search did not return a board two minutes after its
 * creation), and the discovery a creating call schedules must not drop the row that call
 * just recorded (ADR created-resources-join-the-mission).
 */
export const FRESH_RESOURCE_STALE_GRACE_MS = 15 * 60 * 1000;

export interface CreateAccountInput {
  readonly service: string;
  readonly owner: Principal;
  readonly displayName: string;
  /** Clear credential payload (the plugin's serialized credential); sealed by the store
   *  with the account id as associated data. */
  readonly credential: string | null;
  readonly credentialExpiresAt?: Iso | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface AccountFilter {
  readonly service?: string;
  readonly status?: AccountStatus;
}

/**
 * What the operator's reassignment did. `not-ownerless` and `owner-group-empty` are
 * decided inside the write transaction: nothing was written.
 */
export type AssignOwnerlessResult =
  | {
      readonly outcome: 'assigned';
      /** The account as it was read inside the transaction, before the write. */
      readonly previous: AccountRecord;
      readonly account: AccountRecord;
    }
  | { readonly outcome: 'not-ownerless' | 'owner-group-empty' };

export interface AccountsRepo {
  /**
   * Stores a new `active` account. `HostAccountTakenError` when it is a `host` account
   * (`metadata.credential_kind`) and its person already holds one of that service not
   * revoked (index of migration 0040): nothing was written.
   */
  create(input: CreateAccountInput): Promise<AccountRecord>;
  getById(id: string): Promise<AccountRecord | null>;
  list(filter?: AccountFilter): Promise<AccountRecord[]>;
  /**
   * Accounts not revoked, every owner together, by service (an expired or
   * ownerless one included): the count of the `limits.accounts` ceiling and of
   * the counters (spec §4.3 bis). A service with none is absent.
   */
  countByService(): Promise<Record<string, number>>;
  /** Accounts owned by any of the principals (a user and the groups they belong to). */
  listOwnedBy(principals: readonly Principal[]): Promise<AccountRecord[]>;
  /** Decrypts the credential in memory; the caller releases it after the upstream call. */
  getCredential(id: string): Promise<string | null>;
  transferOwner(id: string, owner: Principal): Promise<AccountRecord>;
  /**
   * The operator's reassignment (spec §2.3), with its rule inside the write: in one
   * transaction, the account must be ownerless at that instant (`unowned`, or not
   * revoked with an owner group that has no member — the predicate of `listOwnerless`)
   * and a new owner group must have a member; then the owner is written and an
   * `unowned` account is `active` again (an `expired` one stays `expired`).
   * `NotFoundError` when the account does not exist.
   */
  assignOwnerlessTo(id: string, owner: Principal): Promise<AssignOwnerlessResult>;
  /**
   * `active` → `unowned` for every account nobody owns any more (spec §2.3): its
   * owner group has no member left, or its owner user was deactivated. Returns the
   * accounts that changed. Called after every membership removal and every
   * deactivation; an account that is `expired` stays so.
   */
  markOwnerlessUnowned(): Promise<AccountRecord[]>;
  /**
   * The accounts nobody owns any more: `unowned`, or not revoked with an owner group
   * that has no member or an owner user who is not active (an `expired` one cannot be
   * `unowned` at the same time). What the operator may reassign.
   */
  listOwnerless(): Promise<AccountRecord[]>;
  setMetadata(id: string, metadata: Record<string, unknown> | null): Promise<AccountRecord>;
  /**
   * The owner's default environment label for the account's unlabelled resources;
   * `null` removes it. The caller validates the label against the catalog.
   */
  setDefaultEnv(id: string, env: string | null): Promise<AccountRecord>;
  /** The owner's rename; the caller cleans the name (`cleanName`). */
  setDisplayName(id: string, displayName: string): Promise<AccountRecord>;
  /** Every resource, each with its effective label (`effectiveResourceEnv`). */
  listResources(accountId: string): Promise<AccountResourceRecord[]>;
  getResource(id: string): Promise<AccountResourceRecord | null>;
  setResourceEnv(resourceId: string, env: string | null): Promise<AccountResourceRecord>;

  /**
   * Reconnection by an owner: new credential, status `active`. Only an `active` or an
   * `expired` account is reconnected: revocation is terminal, and nobody reconnects an
   * `unowned` account until an owner is reassigned (spec §2.3). Returns false when
   * nothing was written.
   */
  reconnect(id: string, credential: string, expiresAt?: Iso | null): Promise<boolean>;
  /**
   * Token refresh: seals the new credential only while the account still serves calls
   * (`active` or `unowned`, see `isUnavailableAccountStatus`) and leaves the status
   * alone, so a refresh racing a revocation never resurrects the account. Returns
   * false when nothing was written.
   */
  refreshCredential(id: string, credential: string, expiresAt?: Iso | null): Promise<boolean>;
  /**
   * When the credential stops working, as the service says it again (a pasted key's
   * check on refresh); the credential itself is untouched. Only while the account
   * serves calls; false when nothing was written.
   */
  setCredentialExpiresAt(id: string, expiresAt: Iso | null): Promise<boolean>;
  /**
   * The service rejected the credential and the refresh failed: a serving account
   * (`active` or `unowned`) → `expired`. Conditional, so it never downgrades a `revoked`
   * account. An `unowned` account that expires stays ownerless (`listOwnerless`):
   * the operator reassigns an owner, who reconnects. Returns false when the account
   * was not serving.
   */
  markExpired(id: string): Promise<boolean>;
  /** Terminal revocation: status `revoked`, `revoked_at` set, the credential blob erased. */
  revoke(id: string): Promise<AccountRecord>;
  /**
   * Records what became of the service-side grant of an account that is
   * already revoked. Written once: a row that is not revoked, or that already
   * holds an outcome, is left alone and `null` is returned.
   */
  recordServiceGrant(id: string, outcome: ServiceGrantOutcome): Promise<AccountRecord | null>;
  /**
   * Discovery merge (spec §0 "Resource"): service facts are refreshed, owner edits are
   * kept, nothing is deleted.
   *  - a new ref is inserted; an `env` the plugin returns marks the label `plugin`-set;
   *  - a known ref keeps its id, its owner label, its owner metadata, its `hidden` flag once
   *    the owner hid or showed it (else `hidden` follows the plugin's hint) and its display
   *    name once the owner renamed it; the discovered metadata replaces the
   *    previous service facts; a plugin-set `env` always follows the plugin;
   *  - a ref the discovery no longer returns is marked stale (`staleSince`), unless it
   *    was first seen less than `FRESH_RESOURCE_STALE_GRACE_MS` ago; a stale ref that
   *    comes back is cleared (and counts as first seen again).
   */
  syncDiscoveredResources(
    accountId: string,
    resources: readonly DiscoveredResource[],
  ): Promise<AccountResourceRecord[]>;
  /**
   * The resources a creating call made, read from its answer (ADR
   * created-resources-join-the-mission): each ref is inserted, or — known already — has its
   * stale flag cleared and its service facts merged over the ones it had (the next
   * discovery replaces them whole). Owner edits are kept as by `syncDiscoveredResources`;
   * no other row is touched, nothing is marked stale. A new row carries no label of its
   * own unless the plugin set one, so it reads the account's default environment.
   * Returns the rows of the given refs, in the given order.
   */
  upsertDiscoveredResources(
    accountId: string,
    resources: readonly DiscoveredResource[],
  ): Promise<AccountResourceRecord[]>;
  /** Owner rename; `null` hands the name back to discovery (the current name stays until then). */
  setResourceDisplayName(
    resourceId: string,
    displayName: string | null,
  ): Promise<AccountResourceRecord>;
  setResourceHidden(resourceId: string, hidden: boolean): Promise<AccountResourceRecord>;
  /** Owner edits over the discovered metadata; `null` clears them. */
  setResourceOwnerMetadata(
    resourceId: string,
    metadata: Record<string, unknown> | null,
  ): Promise<AccountResourceRecord>;
}

interface AccountRow {
  id: string;
  service: string;
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
  service_grant: string | null;
  default_env: string | null;
}

/** A resource read with its account's default label (`RESOURCE_READ`). */
interface ResourceReadRow extends ResourceRow {
  default_env: string | null;
}

interface ResourceRow {
  id: string;
  account_id: string;
  ref: string;
  env: string | null;
  display_name: string;
  discovered_at: string;
  metadata_json: string | null;
  owner_metadata_json: string | null;
  env_source: string;
  display_name_edited: number;
  hidden: number;
  hidden_edited: number;
  stale_since: string | null;
  first_seen_at: string | null;
}

/** A `host` account (the Vaubaan account): the kind its connect stored. */
function isHostRecord(record: { readonly metadata?: Record<string, unknown> | null }): boolean {
  return record.metadata?.credential_kind === 'host';
}

/** SQLite's answer to a `UNIQUE` index (a primary key answers `SQLITE_CONSTRAINT_PRIMARYKEY`). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

const COLUMNS = `id, service, owner_kind, owner_user_id, owner_group_id, display_name, status,
  key_version, credential_expires_at, metadata_json, created_at, updated_at, revoked_at,
  service_grant, default_env`;
const RESOURCE_COLUMNS = `id, account_id, ref, env, display_name, discovered_at, metadata_json,
  owner_metadata_json, env_source, display_name_edited, hidden, hidden_edited, stale_since,
  first_seen_at`;
/**
 * Every read that becomes a `AccountResourceRecord` goes through this join, so the
 * effective label (own label, else the account's default) is computed in one place.
 */
const RESOURCE_READ = `SELECT r.id, r.account_id, r.ref, r.env, r.display_name, r.discovered_at,
  r.metadata_json, r.owner_metadata_json, r.env_source, r.display_name_edited, r.hidden,
  r.hidden_edited, r.stale_since, r.first_seen_at, c.default_env
  FROM account_resources r JOIN accounts c ON c.id = r.account_id`;

/** Every status of the schema's `CHECK`; a status added to the union fails to compile here. */
const ACCOUNT_STATUSES = Object.keys({
  active: true,
  expired: true,
  revoked: true,
  unowned: true,
} satisfies Record<AccountStatus, true>) as AccountStatus[];

/** The statuses whose credential is still used for calls: gateway-core decides, not this file. */
const SERVING_STATUSES: readonly AccountStatus[] = ACCOUNT_STATUSES.filter(
  (status) => !isUnavailableAccountStatus(status),
);

/** The statuses an owner may reconnect from (spec §2.3): neither `revoked` nor `unowned`. */
const RECONNECTABLE_STATUSES: readonly AccountStatus[] = ['active', 'expired'];

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    service: row.service,
    owner: principalFromColumns(row.owner_kind, row.owner_user_id, row.owner_group_id),
    displayName: row.display_name,
    status: parseEnum(ACCOUNT_STATUSES, row.status, 'accounts.status'),
    keyVersion: row.key_version,
    credentialExpiresAt: row.credential_expires_at,
    metadata: parseJsonObject(row.metadata_json, 'accounts.metadata_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    serviceGrant:
      row.service_grant === null
        ? null
        : parseEnum(SERVICE_GRANT_OUTCOMES, row.service_grant, 'accounts.service_grant'),
    defaultEnv: row.default_env,
  };
}

function resourceToRecord(row: ResourceReadRow): AccountResourceRecord {
  const discovered = parseJsonObject(row.metadata_json, 'account_resources.metadata_json');
  const ownerMetadata = parseJsonObject(
    row.owner_metadata_json,
    'account_resources.owner_metadata_json',
  );
  const { env, envSource } = effectiveResourceEnv(
    {
      env: row.env,
      envSource: parseEnum(RESOURCE_ENV_SOURCES, row.env_source, 'account_resources.env_source'),
    },
    row.default_env,
  );
  return {
    id: row.id,
    accountId: row.account_id,
    ref: row.ref,
    env,
    displayName: row.display_name,
    discoveredAt: row.discovered_at,
    envSource,
    metadata: discovered || ownerMetadata ? { ...discovered, ...ownerMetadata } : null,
    ownerMetadata,
    displayNameEdited: row.display_name_edited === 1,
    hidden: row.hidden === 1,
    hiddenEdited: row.hidden_edited === 1,
    staleSince: row.stale_since,
  };
}

export function createAccountsRepo(ctx: RepoContext): AccountsRepo {
  const { db, encryptor } = ctx;
  const byId = db.prepare<[string], AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`);
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
    `INSERT INTO accounts (id, service, owner_kind, owner_user_id, owner_group_id, display_name,
       status, credential_blob, key_version, credential_expires_at, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const countByServiceStmt = db.prepare<[], { readonly service: string; readonly n: number }>(
    `SELECT service, COUNT(*) AS n FROM accounts WHERE status <> 'revoked'
     GROUP BY service ORDER BY service`,
  );
  const credentialStmt = db.prepare<
    [string],
    { credential_blob: Buffer | null; key_version: number | null }
  >('SELECT credential_blob, key_version FROM accounts WHERE id = ?');
  const setOwnerStmt = db.prepare<[string, string | null, string | null, string, string]>(
    `UPDATE accounts SET owner_kind = ?, owner_user_id = ?, owner_group_id = ?, updated_at = ? WHERE id = ?`,
  );
  const setMetadataStmt = db.prepare<[string | null, string, string]>(
    'UPDATE accounts SET metadata_json = ?, updated_at = ? WHERE id = ?',
  );
  const resourcesOf = db.prepare<[string], ResourceReadRow>(
    `${RESOURCE_READ} WHERE r.account_id = ? ORDER BY r.ref`,
  );
  const resourceById = db.prepare<[string], ResourceReadRow>(`${RESOURCE_READ} WHERE r.id = ?`);
  const setDefaultEnvStmt = db.prepare<[string | null, string, string]>(
    'UPDATE accounts SET default_env = ?, updated_at = ? WHERE id = ?',
  );
  const setAccountNameStmt = db.prepare<[string, string, string]>(
    'UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?',
  );
  const setEnv = db.prepare<[string | null, string]>(
    "UPDATE account_resources SET env = ?, env_source = 'owner' WHERE id = ?",
  );
  const reconnectStmt = db.prepare<[Buffer, number, string | null, string, string, ...string[]]>(
    `UPDATE accounts SET credential_blob = ?, key_version = ?, credential_expires_at = ?,
       status = 'active', updated_at = ?
     WHERE id = ? AND status IN (${placeholders(RECONNECTABLE_STATUSES.length)})`,
  );
  const refreshCredentialStmt = db.prepare<
    [Buffer, number, string | null, string, string, ...string[]]
  >(
    `UPDATE accounts SET credential_blob = ?, key_version = ?, credential_expires_at = ?,
       updated_at = ? WHERE id = ? AND status IN (${placeholders(SERVING_STATUSES.length)})`,
  );
  const setExpiresAtStmt = db.prepare<[string | null, string, string, ...string[]]>(
    `UPDATE accounts SET credential_expires_at = ?, updated_at = ?
     WHERE id = ? AND status IN (${placeholders(SERVING_STATUSES.length)})`,
  );
  const markExpiredStmt = db.prepare<[string, string, ...string[]]>(
    `UPDATE accounts SET status = 'expired', updated_at = ?
     WHERE id = ? AND status IN (${placeholders(SERVING_STATUSES.length)})`,
  );
  const assignOwnerStmt = db.prepare<[string, string | null, string | null, string, string]>(
    `UPDATE accounts SET owner_kind = ?, owner_user_id = ?, owner_group_id = ?,
       status = CASE WHEN status = 'unowned' THEN 'active' ELSE status END, updated_at = ?
     WHERE id = ?`,
  );
  // Nobody owns it: its owner group has no member, or its owner user is not active
  // (deactivated by an operator: they hold nothing, so they cannot share or reconnect).
  const NO_MEMBER = `((owner_kind = 'group' AND NOT EXISTS (
       SELECT 1 FROM group_members gm WHERE gm.group_id = accounts.owner_group_id))
     OR (owner_kind = 'user' AND NOT EXISTS (
       SELECT 1 FROM users u WHERE u.id = accounts.owner_user_id AND u.status = 'active')))`;
  const ownerlessActive = db.prepare<[], AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE status = 'active' AND ${NO_MEMBER} ORDER BY created_at`,
  );
  const markUnownedStmt = db.prepare<[string, string]>(
    "UPDATE accounts SET status = 'unowned', updated_at = ? WHERE id = ? AND status = 'active'",
  );
  const ownerless = db.prepare<[], AccountRow>(
    `SELECT ${COLUMNS} FROM accounts
     WHERE status = 'unowned' OR (status <> 'revoked' AND ${NO_MEMBER}) ORDER BY created_at`,
  );
  const isOwnerless = db.prepare<[string], { found: number }>(
    `SELECT 1 AS found FROM accounts
     WHERE id = ? AND (status = 'unowned' OR (status <> 'revoked' AND ${NO_MEMBER}))`,
  );
  const groupHasMember = db.prepare<[string], { found: number }>(
    'SELECT 1 AS found FROM group_members WHERE group_id = ? LIMIT 1',
  );
  const revokeStmt = db.prepare<[string, string, string]>(
    `UPDATE accounts SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?),
       credential_blob = NULL, key_version = NULL, credential_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const serviceGrantStmt = db.prepare<[string, string]>(
    `UPDATE accounts SET service_grant = ?
     WHERE id = ? AND status = 'revoked' AND service_grant IS NULL`,
  );
  const resourceByRef = db.prepare<[string, string], ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM account_resources WHERE account_id = ? AND ref = ?`,
  );
  const insertDiscovered = db.prepare<
    [string, string, string, string | null, string, string, string | null, string, string, number]
  >(
    `INSERT INTO account_resources (id, account_id, ref, env, display_name, discovered_at,
       metadata_json, env_source, first_seen_at, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The plugin's hidden hint, on a row whose owner never hid nor showed it (migration 0034).
  const hintHidden = db.prepare<[number, string]>(
    'UPDATE account_resources SET hidden = ? WHERE id = ? AND hidden_edited = 0',
  );
  // A stale row that comes back counts as first seen again: the grace protects it anew.
  const updateDiscovered = db.prepare<
    [string | null, string, string, string, string | null, string, string]
  >(
    `UPDATE account_resources SET env = ?, env_source = ?, display_name = ?, discovered_at = ?,
       metadata_json = ?,
       first_seen_at = CASE WHEN stale_since IS NULL THEN first_seen_at ELSE ? END,
       stale_since = NULL
     WHERE id = ?`,
  );
  // A row first seen after the cut-off is within its grace: left as it is.
  const markStale = db.prepare<[string, string, string]>(
    `UPDATE account_resources SET stale_since = COALESCE(stale_since, ?)
     WHERE id = ? AND (first_seen_at IS NULL OR first_seen_at <= ?)`,
  );
  const setDisplayNameStmt = db.prepare<[string, number, string]>(
    'UPDATE account_resources SET display_name = ?, display_name_edited = ? WHERE id = ?',
  );
  // The owner's choice: discovery no longer changes it (`hidden_edited`).
  const setHiddenStmt = db.prepare<[number, string]>(
    'UPDATE account_resources SET hidden = ?, hidden_edited = 1 WHERE id = ?',
  );
  const setOwnerMetadataStmt = db.prepare<[string | null, string]>(
    'UPDATE account_resources SET owner_metadata_json = ? WHERE id = ?',
  );

  function requireAccount(id: string): AccountRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('account', id);
    return toRecord(row);
  }

  /**
   * One discovered ref merged into the account's rows (`syncDiscoveredResources`,
   * `upsertDiscoveredResources`): inserted, or refreshed with the owner's edits kept.
   * `keepMetadata` merges the new service facts over the ones the row has instead of
   * replacing them (a creating call knows fewer facts than a discovery). Inside the
   * caller's transaction.
   */
  function mergeDiscovered(
    accountId: string,
    r: DiscoveredResource,
    now: Iso,
    keepMetadata: boolean,
  ): void {
    const pluginEnv = r.env ?? null;
    const existing = resourceByRef.get(accountId, r.ref);
    if (!existing) {
      insertDiscovered.run(
        ctx.newId(),
        accountId,
        r.ref,
        pluginEnv,
        r.displayName,
        now,
        toJson(r.metadata ?? null),
        pluginEnv !== null ? 'plugin' : 'owner',
        now,
        r.hidden === true ? 1 : 0,
      );
      return;
    }
    const known = keepMetadata
      ? parseJsonObject(existing.metadata_json, 'account_resources.metadata_json')
      : null;
    const metadata = known ? { ...known, ...(r.metadata ?? {}) } : (r.metadata ?? null);
    updateDiscovered.run(
      // A label the plugin sets follows the plugin; otherwise the owner's label stays
      // (and becomes editable again if the plugin used to set it).
      pluginEnv ?? existing.env,
      pluginEnv !== null ? 'plugin' : 'owner',
      existing.display_name_edited === 1 ? existing.display_name : r.displayName,
      now,
      toJson(metadata),
      now,
      existing.id,
    );
    // A discovery states the hint in full; a creating call's answer says nothing of it.
    if (!keepMetadata) hintHidden.run(r.hidden === true ? 1 : 0, existing.id);
  }

  function requireResource(id: string): AccountResourceRecord {
    const row = resourceById.get(id);
    if (!row) throw new NotFoundError('account_resource', id);
    return resourceToRecord(row);
  }

  return {
    async create(input) {
      const id = ctx.newId();
      const now = nowIso(ctx);
      const owner = principalColumns(input.owner);
      const sealed =
        input.credential !== null ? await sealText(encryptor, id, input.credential) : null;
      try {
        insert.run(
          id,
          input.service,
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
      } catch (err) {
        // The id is new, so the one unique constraint an insert can meet is the index of
        // migration 0040: one `host` account not revoked per person and service.
        if (isUniqueViolation(err) && owner.userId !== null && isHostRecord(input)) {
          throw new HostAccountTakenError(input.service, owner.userId);
        }
        throw err;
      }
      return requireAccount(id);
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async countByService() {
      const counts: Record<string, number> = {};
      for (const row of countByServiceStmt.all()) counts[row.service] = row.n;
      return counts;
    },
    async list(filter = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.service) {
        where.push('service = ?');
        params.push(filter.service);
      }
      if (filter.status) {
        where.push('status = ?');
        params.push(filter.status);
      }
      const sql = `SELECT ${COLUMNS} FROM accounts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
      return db
        .prepare<string[], AccountRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async listOwnedBy(principals) {
      const pred = principalPredicate(principals, 'owner_user_id', 'owner_group_id');
      return db
        .prepare<string[], AccountRow>(
          `SELECT ${COLUMNS} FROM accounts WHERE ${pred.sql} ORDER BY created_at`,
        )
        .all(...pred.params)
        .map(toRecord);
    },
    async getCredential(id) {
      const row = credentialStmt.get(id);
      if (!row) throw new NotFoundError('account', id);
      return openSealedColumn(encryptor, id, row.credential_blob, row.key_version);
    },
    async transferOwner(id, owner) {
      const cols = principalColumns(owner);
      const now = nowIso(ctx);
      // Check and write in one transaction: a revocation between the two is impossible.
      return withImmediateTransaction(db, () => {
        const current = requireAccount(id);
        if (current.status === 'revoked') {
          throw new InvariantError('a revoked account cannot change owner');
        }
        setOwnerStmt.run(cols.kind, cols.userId, cols.groupId, now, id);
        return requireAccount(id);
      });
    },
    async setMetadata(id, metadata) {
      const result = setMetadataStmt.run(toJson(metadata), nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('account', id);
      return requireAccount(id);
    },
    async setDefaultEnv(id, env) {
      const result = setDefaultEnvStmt.run(env, nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('account', id);
      return requireAccount(id);
    },
    async setDisplayName(id, displayName) {
      const result = setAccountNameStmt.run(displayName, nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('account', id);
      return requireAccount(id);
    },
    async listResources(accountId) {
      return resourcesOf.all(accountId).map(resourceToRecord);
    },
    async getResource(id) {
      const row = resourceById.get(id);
      return row ? resourceToRecord(row) : null;
    },
    async setResourceEnv(resourceId, env) {
      const result = setEnv.run(env, resourceId);
      if (result.changes === 0) throw new NotFoundError('account_resource', resourceId);
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
    async setCredentialExpiresAt(id, expiresAt) {
      return setExpiresAtStmt.run(expiresAt, nowIso(ctx), id, ...SERVING_STATUSES).changes > 0;
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
        const previous = requireAccount(id);
        if (!isOwnerless.get(id)) return { outcome: 'not-ownerless' };
        if (owner.kind === 'group' && !groupHasMember.get(owner.id)) {
          return { outcome: 'owner-group-empty' };
        }
        assignOwnerStmt.run(cols.kind, cols.userId, cols.groupId, now, id);
        return { outcome: 'assigned', previous, account: requireAccount(id) };
      });
    },
    async markOwnerlessUnowned() {
      const now = nowIso(ctx);
      // Read and write in one transaction: a member joining between the two is impossible.
      return withImmediateTransaction(db, () => {
        const changed: AccountRecord[] = [];
        for (const row of ownerlessActive.all()) {
          // A host account follows its person: never handed to anyone else (ADR
          // platform-management-is-a-plugin-on-the-execution-door).
          if (isHostRecord(toRecord(row))) continue;
          if (markUnownedStmt.run(now, row.id).changes > 0) changed.push(requireAccount(row.id));
        }
        return changed;
      });
    },
    async listOwnerless() {
      return ownerless
        .all()
        .map(toRecord)
        .filter((record) => !isHostRecord(record));
    },
    async revoke(id) {
      const now = nowIso(ctx);
      const result = revokeStmt.run(now, now, id);
      if (result.changes === 0) throw new NotFoundError('account', id);
      return requireAccount(id);
    },
    async recordServiceGrant(id, outcome) {
      if (!SERVICE_GRANT_OUTCOMES.includes(outcome)) {
        throw new InvariantError(`unknown service grant outcome '${String(outcome)}'`);
      }
      return serviceGrantStmt.run(outcome, id).changes === 1 ? requireAccount(id) : null;
    },
    async syncDiscoveredResources(accountId, resources) {
      requireAccount(accountId);
      const now = nowIso(ctx);
      const graceCutoff = toIso(new Date(Date.parse(now) - FRESH_RESOURCE_STALE_GRACE_MS));
      withImmediateTransaction(db, () => {
        const seen = new Set<string>();
        for (const r of resources) {
          if (seen.has(r.ref)) continue; // a plugin listing a ref twice: the first one wins
          seen.add(r.ref);
          mergeDiscovered(accountId, r, now, false);
        }
        for (const row of resourcesOf.all(accountId)) {
          if (!seen.has(row.ref)) markStale.run(now, row.id, graceCutoff);
        }
      });
      return resourcesOf.all(accountId).map(resourceToRecord);
    },
    async upsertDiscoveredResources(accountId, resources) {
      requireAccount(accountId);
      const now = nowIso(ctx);
      const refs: string[] = [];
      withImmediateTransaction(db, () => {
        for (const r of resources) {
          if (refs.includes(r.ref)) continue; // the first one wins, as in a discovery
          refs.push(r.ref);
          mergeDiscovered(accountId, r, now, true);
        }
      });
      return refs.flatMap((ref) => {
        const row = resourceByRef.get(accountId, ref);
        return row ? [requireResource(row.id)] : [];
      });
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
      if (result.changes === 0) throw new NotFoundError('account_resource', resourceId);
      return requireResource(resourceId);
    },
    async setResourceOwnerMetadata(resourceId, metadata) {
      const result = setOwnerMetadataStmt.run(toJson(metadata), resourceId);
      if (result.changes === 0) throw new NotFoundError('account_resource', resourceId);
      return requireResource(resourceId);
    },
  };
}
