import { assertKnownRiskIds } from '../catalog-index.ts';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError, TokenNotIssuableError } from '../errors.ts';
import { isOnMission, membershipOf } from '../membership.ts';
import { MISSION_TOKEN_KINDS } from '@vaubaan/shared';

import {
  MISSION_RESOURCE_SOURCES,
  MISSION_TOKEN_STATUSES,
  RESOURCE_SCOPES,
  USER_STATUSES,
  type Gate,
  type Iso,
  type MissionConnection,
  type MissionIssuerRecord,
  type MissionMemberRecord,
  type MissionPolicyEntry,
  type MissionRecord,
  type MissionResourceSource,
  type ResourceScope,
  type MissionStatus,
  type MissionTokenRecord,
  type NewEvent,
  type RiskId,
  type TokenHolderRecord,
} from '../types.ts';
import { nowIso, parseEnum, requireRow, type RepoContext } from './context.ts';
import { GATES, STORED_MISSION_STATUSES } from './enums.ts';
import { createSessionPrimitives } from './sessions.ts';

export interface CreateMissionInput {
  readonly name: string;
  readonly creatorUserId: string;
  /** Start of the first period; defaults to the creation instant. */
  readonly periodAnchor?: Iso;
  /** Period length in seconds; null for a one-off mission. */
  readonly periodSeconds: number | null;
  readonly expiresAt?: Iso | null;
  readonly delegationId?: string | null;
  readonly connections: readonly MissionConnection[];
  /** One entry per accepted risk, each with its budget. Every id must be in the catalog. */
  readonly policy: readonly MissionPolicyEntry[];
}

export interface IssueTokenInput {
  readonly missionId: string;
  readonly prefix: string;
  readonly hash: string;
  readonly hashAlg: string;
  /** Who the token belongs to. */
  readonly holder: TokenHolderRecord;
  /** The user who generates or creates it. */
  readonly createdBy: string;
  /**
   * A named token this one replaces (the creator's "Replace key" on a machine key):
   * its id. The old token is retired (`rotated`) and the new one inserted under the
   * same name in ONE transaction, so there is no instant at which the name is free
   * or two keys of it work. The holder must be that token's name.
   */
  readonly replacing?: string;
}

export interface AddedMember {
  readonly member: MissionMemberRecord;
  /** A working token that predated the membership, revoked with it; normally `null`. */
  readonly tokenRevoked: MissionTokenRecord | null;
}

export interface IssuedToken {
  readonly token: MissionTokenRecord;
  /** The holder's previous active token, now `rotated`; `null` for a first token. */
  readonly replaced: MissionTokenRecord | null;
}

export interface AddMemberInput {
  readonly missionId: string;
  readonly userId: string;
  readonly addedBy: string;
}

export interface RemovedMember {
  readonly member: MissionMemberRecord;
  /** The member's active token, revoked in the same transaction; `null` when they had none. */
  readonly tokenRevoked: MissionTokenRecord | null;
}

/** The call that created the resources `addResources` adds (source `created`). */
export interface CreatedBy {
  readonly tool: string;
  /** The human behind the call's key. */
  readonly actorUserId: string | null;
}

/** What `addResources` did on one connection of a mission. */
export interface AddedMissionResources {
  /** The connection's scope after the write (`all` with an id becomes `selected`). */
  readonly scope: ResourceScope;
  /** The ids written now, in the given order; an id already selected is not repeated. */
  readonly added: readonly string[];
}

/** What the `missions.status` column may hold: every `MissionStatus` but the derived one. */
export type StoredMissionStatus = Exclude<MissionStatus, 'orphaned'>;

export interface MissionsRepo {
  /**
   * The creator's edit of the whole mission after issuance (ADR
   * mission-editable-after-issuance): the mission becomes `connections` and `policy`,
   * named `name`, expiring at `expiresAt`. In one `BEGIN IMMEDIATE` transaction: the
   * mission is read again, and nothing is written (`null`) unless `actorUserId` is its
   * creator, its stored status is not `revoked` and `unchanged(mission)` holds — the
   * edit was judged against that very state. Only the rows that move are written: a
   * kept connection or resource row is not rewritten (it keeps its `source`), and a
   * resource row the edit adds carries `source = 'edit'`. An expiry moved into the future
   * (or removed) brings a mission stored `expired` back to `active`. Open claims and
   * approval requests about a removed risk are closed (`refused`, `mission-changed`),
   * unconsumed approvals covering one are retired, and, when the mission has a
   * session, one event per risk that moved is recorded (`permission-added`,
   * `permission-removed`, `limits-changed`, `gate-changed`), the closed requests'
   * `request` events, then `summary(requestsClosed)`.
   */
  edit(id: string, edit: MissionEditInput): Promise<MissionEditResult | null>;
  changePermissions(
    id: string,
    policy: readonly MissionPolicyEntry[],
    expected: readonly MissionPolicyEntry[],
    actor: string,
    requestId?: string,
  ): Promise<MissionRecord | null>;
  create(input: CreateMissionInput): Promise<MissionRecord>;
  /**
   * Adds resources of one of the mission's connections to its explicit selection, each
   * row marked with `source` (ADR created-resources-join-the-mission: `created` for a
   * resource the mission created). Scope `connection` already reaches every resource of
   * the connection: nothing is written. Scope `all` that stored nothing becomes
   * `selected`. An id already selected keeps its row and its source. One transaction.
   * `NotFoundError` when the mission does not carry the connection; `InvariantError`
   * when a resource is not one of that connection's. With `created`, the mission's
   * session (when it has one) records a `resources-created` event in the same
   * transaction, whatever the scope: the mission reaches what it created.
   */
  addResources(
    missionId: string,
    connectionId: string,
    resourceIds: readonly string[],
    source: MissionResourceSource,
    created?: CreatedBy,
  ): Promise<AddedMissionResources>;
  getById(id: string): Promise<MissionRecord | null>;
  listForCreator(userId: string): Promise<MissionRecord[]>;
  /**
   * How many missions are active at `now`: stored `active` and not past their
   * expiry. Orphaned ones are derived elsewhere and still counted here: the
   * figure is the instance profile's bucket (spec §9), not an authority check.
   */
  countActive(now: Iso): Promise<number>;
  /** The missions this user is a current member of (never the ones they created). */
  listForMember(userId: string): Promise<MissionRecord[]>;
  listForConnection(connectionId: string): Promise<MissionRecord[]>;
  /**
   * The client behind each of these missions that was issued through the
   * management door, keyed by mission id. A mission issued in the interface
   * has no entry.
   */
  issuersOf(missionIds: readonly string[]): Promise<Map<string, MissionIssuerRecord>>;
  /**
   * `orphaned` is not a stored status (spec §2.3: derived from the creator's current
   * authority, never stored as a verdict): the type refuses it here, and the trigger of
   * migration 0007 refuses it in the table.
   */
  setStatus(id: string, status: StoredMissionStatus): Promise<MissionRecord>;
  setExpiresAt(id: string, expiresAt: Iso | null): Promise<MissionRecord>;
  /** The creator enlarges or shrinks the mission; the whole policy is replaced atomically. */
  replacePolicy(id: string, policy: readonly MissionPolicyEntry[]): Promise<MissionRecord>;
  /**
   * Sets the gate of one accepted risk (spec §3.5 "at issuance, or later") and, when the
   * mission has a session, records the `gate-changed` event in the same transaction: the
   * event is what ends a gate opening granted earlier in the period, so the two must not
   * come apart. Returns the gate the risk had; `null` (nothing written) when the risk is
   * not in the mission's policy. Setting the gate it already has writes nothing.
   */
  setGate(
    id: string,
    riskId: RiskId,
    gate: Gate,
    actorUserId: string,
    options?: SetGateOptions,
  ): Promise<{
    readonly mission: MissionRecord;
    readonly previous: Gate;
    /** A `gate-changed` event was recorded although the stored gate did not move. */
    readonly openingClosed: boolean;
  } | null>;
  /**
   * Changes the limits of accepted risks after issuance (the creator's "Change limits"):
   * the quota per period and the number of calls of the rate window, nothing else — the
   * rate window, the gate and the list of accepted risks stay as they are. In one
   * transaction: every listed risk is read, the ones whose values move are written, and,
   * when the mission has a session, one `limits-changed` event per changed risk is
   * recorded. Returns each listed risk with its limits before and after; `null` (nothing
   * written) when a listed risk is not in the mission's policy. The budget reads the
   * policy rows inside its own decision transaction, so no call decided after this
   * commit sees the old values.
   */
  setLimits(
    id: string,
    changes: readonly LimitChange[],
    actorUserId: string,
  ): Promise<{
    readonly mission: MissionRecord;
    readonly changes: readonly AppliedLimitChange[];
  } | null>;
  /**
   * Issues a token to one holder. A member's previous active token becomes `rotated`
   * in the same transaction (at most one active token per member of a mission); the
   * tokens of the other holders are untouched. A named token whose name an active
   * token of the mission already carries is refused
   * (`TokenNotIssuableError('name-taken')`): a name identifies one token. So is a
   * token on a mission whose stored status is not `active`, or for a holder who is
   * not on the mission: both are read again inside the transaction.
   */
  issueToken(input: IssueTokenInput): Promise<IssuedToken>;
  findTokenByPrefix(
    prefix: string,
  ): Promise<{ token: MissionTokenRecord; mission: MissionRecord } | null>;
  getToken(tokenId: string): Promise<MissionTokenRecord | null>;
  /** Every token of the mission, whatever its status, oldest first. */
  listTokens(missionId: string): Promise<MissionTokenRecord[]>;
  /** Revokes every non-retired token of the mission; returns how many were revoked. */
  revokeTokens(missionId: string): Promise<number>;
  /** Revokes one active token; `null` (nothing written) when it is not active or unknown. */
  revokeToken(tokenId: string): Promise<MissionTokenRecord | null>;
  /**
   * Revokes every active member token this user holds on a mission they did not
   * create — the tokens of a deactivated member. Their tokens on their own missions
   * are left alone: those missions read `orphaned` by the derived rule and serve
   * again, same token, if the user is reactivated. Returns the revoked rows.
   */
  revokeMemberTokensOf(userId: string): Promise<MissionTokenRecord[]>;
  /**
   * Records that the door authenticated a call with this token. Written at most once
   * per `granularitySeconds`: the column says "about when", not "exactly when", so a
   * busy agent does not turn every call into a write. Returns whether a row was written.
   */
  markTokenUsed(tokenId: string, granularitySeconds: number): Promise<boolean>;
  /**
   * Replaces the stored proof of one token by another proof of the SAME secret
   * (a row an earlier build stored as argon2id, moved to the SHA-256 digest once
   * its Bearer matched). Written only while the row still holds `fromHash`, so
   * two concurrent calls write once and a row changed meanwhile is left alone.
   * Nothing else of the row moves: same id, prefix, status and holder. Returns
   * whether a row was written.
   */
  rehashToken(
    tokenId: string,
    change: { readonly fromHash: string; readonly hash: string; readonly hashAlg: string },
  ): Promise<boolean>;

  /**
   * Gives a user access to the mission. Adding a removed member again clears
   * `removed_at` (their old token stays revoked). The creator is never a row: adding
   * them is refused (`InvariantError`). A member starts with no token: a working
   * member token of that user found on the mission is revoked in the same
   * transaction and returned (`tokenRevoked`), `null` when there was none.
   */
  addMember(input: AddMemberInput): Promise<AddedMember>;
  /**
   * Removes a current member and revokes their active token, in one transaction: there
   * is no instant at which a removed member still holds a working token. `null` when
   * the user is not a current member.
   */
  removeMember(missionId: string, userId: string): Promise<RemovedMember | null>;
  /** The member's row, removed or not; `null` when the user was never a member. */
  getMember(missionId: string, userId: string): Promise<MissionMemberRecord | null>;
  /** The current members, in the order they were added. Never the creator. */
  listMembers(missionId: string): Promise<MissionMemberRecord[]>;
}

/** What `MissionsRepo.edit` makes of a mission. */
export interface MissionEditInput {
  readonly actorUserId: string;
  /** The state the edit was judged against still stands; read inside the transaction. */
  readonly unchanged: (current: MissionRecord) => boolean;
  readonly name: string;
  readonly expiresAt: Iso | null;
  /** Every connection of the mission after the edit, with its selection. */
  readonly connections: readonly MissionConnection[];
  /** The whole policy after the edit. */
  readonly policy: readonly MissionPolicyEntry[];
  /** The session's summary event of the edit, given how many requests it closed. */
  readonly summary: (requestsClosed: number) => NewEvent;
}

export interface MissionEditResult {
  readonly before: MissionRecord;
  readonly mission: MissionRecord;
  /** The open requests the edit made moot, now closed. */
  readonly closedRequests: readonly { readonly id: string; readonly kind: string }[];
}

/** The new limits of one accepted risk (`MissionsRepo.setLimits`). */
export interface LimitChange {
  readonly riskId: RiskId;
  readonly quota: number;
  /** Calls allowed per rate window; the window itself does not change. */
  readonly rateLimit: number;
}

/** One listed risk as `setLimits` found it and left it. */
export interface AppliedLimitChange {
  readonly riskId: RiskId;
  readonly before: { readonly quota: number; readonly rateLimit: number };
  readonly after: { readonly quota: number; readonly rateLimit: number };
  /** Its stored window, unchanged: what `rateLimit` counts over. */
  readonly rateWindowSeconds: number;
  /** False when the values asked were the ones it had: nothing was written for it. */
  readonly changed: boolean;
}

export interface SetGateOptions {
  /**
   * The caller found the gate of this risk open for the period (a `gate-opened` event
   * later than its last `gate-changed`): when the stored gate is already `approval`
   * and `approval` is asked, a `gate-changed` event is still recorded, which is what
   * ends an opening. Without it the edit would be a silent no-op and the opening stay.
   */
  readonly closeOpening?: boolean;
}

interface MissionRow {
  id: string;
  name: string;
  creator_user_id: string;
  status: string;
  period_anchor: string;
  period_seconds: number | null;
  expires_at: string | null;
  delegation_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface IssuerRow {
  mission_id: string;
  delegation_id: string;
  client_id: string;
  name: string;
}

interface PolicyRow {
  risk_id: string;
  quota: number;
  rate_limit: number;
  rate_window_seconds: number;
  gate: string;
}

interface ConnectionRow {
  connection_id: string;
  resource_scope: string;
  crans_json: string | null;
}

interface SelectedRow {
  resource_id: string;
  source: string;
}

interface TokenRow {
  id: string;
  mission_id: string;
  prefix: string;
  hash: string;
  hash_alg: string;
  status: string;
  kind: string;
  holder_user_id: string | null;
  name: string | null;
  created_by: string;
  created_at: string;
  retired_at: string | null;
  last_used_at: string | null;
}

interface MemberRow {
  mission_id: string;
  user_id: string;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

const MS_PER_SECOND = 1000;

const COLUMNS = `id, name, creator_user_id, status, period_anchor, period_seconds, expires_at,
  delegation_id, created_at, updated_at, closed_at`;
const TOKEN_COLUMNS = `id, mission_id, prefix, hash, hash_alg, status, kind, holder_user_id, name,
  created_by, created_at, retired_at, last_used_at`;
const MEMBER_COLUMNS = 'mission_id, user_id, added_by, added_at, removed_at';

/** The holder of a row. The schema's CHECK guarantees the pairing; a row that breaks it is corrupt. */
function holderOf(row: TokenRow): TokenHolderRecord {
  const kind = parseEnum(MISSION_TOKEN_KINDS, row.kind, 'mission_tokens.kind');
  if (kind === 'member') {
    if (row.holder_user_id === null) {
      throw new InvariantError(`mission_tokens ${row.id}: a member token without a holder`);
    }
    return { kind, userId: row.holder_user_id };
  }
  if (row.name === null) {
    throw new InvariantError(`mission_tokens ${row.id}: a named token without a name`);
  }
  return { kind, name: row.name };
}

function tokenToRecord(row: TokenRow): MissionTokenRecord {
  const holder = holderOf(row);
  return {
    id: row.id,
    missionId: row.mission_id,
    prefix: row.prefix,
    hash: row.hash,
    hashAlg: row.hash_alg,
    status: parseEnum(MISSION_TOKEN_STATUSES, row.status, 'mission_tokens.status'),
    kind: holder.kind,
    holder,
    createdBy: row.created_by,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    lastUsedAt: row.last_used_at,
  };
}

function memberToRecord(row: MemberRow): MissionMemberRecord {
  return {
    missionId: row.mission_id,
    userId: row.user_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
    removedAt: row.removed_at,
  };
}

function policyToRecord(row: PolicyRow): MissionPolicyEntry {
  return {
    riskId: row.risk_id,
    quota: row.quota,
    rateLimit: row.rate_limit,
    rateWindowSeconds: row.rate_window_seconds,
    gate: parseEnum(GATES, row.gate, 'mission_policy.gate'),
  };
}

function connectionToRecord(
  row: ConnectionRow,
  selected: readonly SelectedRow[],
): MissionConnection {
  const sources: Record<string, MissionResourceSource> = {};
  for (const r of selected) {
    const source = parseEnum(MISSION_RESOURCE_SOURCES, r.source, 'mission_resources.source');
    if (source !== 'issuance') sources[r.resource_id] = source;
  }
  return {
    connectionId: row.connection_id,
    resourceScope: parseEnum(
      RESOURCE_SCOPES,
      row.resource_scope,
      'mission_connections.resource_scope',
    ),
    resourceIds: selected.map((r) => r.resource_id),
    ...(Object.keys(sources).length > 0 ? { resourceSources: sources } : {}),
    ...(row.crans_json === null ? {} : { crans: cransOf(row.crans_json) }),
  };
}

/** `crans_json` as stored: an object of strings; anything else is corrupt. */
function cransOf(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvariantError('mission_connections.crans_json is not an object');
  }
  const crans: Record<string, string> = {};
  for (const [id, cran] of Object.entries(parsed)) {
    if (typeof cran !== 'string') {
      throw new InvariantError(`mission_connections.crans_json: '${id}' is not a string`);
    }
    crans[id] = cran;
  }
  return crans;
}

/** What `crans_json` stores: NULL for no cran, so an empty record reads back absent. */
function cransJsonOf(c: Pick<MissionConnection, 'crans'>): string | null {
  return c.crans && Object.keys(c.crans).length > 0 ? JSON.stringify(c.crans) : null;
}

/**
 * Every connection carries an explicit, consistent selection (`selected`), or no id at
 * all (`all`: none known at issuance; `connection`: the whole connection, read live).
 */
function assertConnectionSelections(
  ctx: RepoContext,
  connections: readonly MissionConnection[],
): void {
  if (connections.length === 0) {
    throw new InvariantError('a mission carries at least one connection');
  }
  const resourceConnection = ctx.db.prepare<[string], { connection_id: string }>(
    'SELECT connection_id FROM connection_resources WHERE id = ?',
  );
  for (const c of connections) {
    if (c.resourceScope === 'selected' && c.resourceIds.length === 0) {
      throw new InvariantError(`connection ${c.connectionId}: selected scope with no resource`);
    }
    if (c.resourceScope !== 'selected' && c.resourceIds.length > 0) {
      throw new InvariantError(
        `connection ${c.connectionId}: '${c.resourceScope}' scope lists resources`,
      );
    }
    for (const resourceId of c.resourceIds) {
      const owner = resourceConnection.get(resourceId);
      if (!owner) throw new NotFoundError('connection_resource', resourceId);
      if (owner.connection_id !== c.connectionId) {
        throw new InvariantError(
          `resource ${resourceId} does not belong to connection ${c.connectionId}`,
        );
      }
    }
  }
}

function validatePolicy(ctx: RepoContext, policy: readonly MissionPolicyEntry[]): void {
  const ids = policy.map((p) => p.riskId);
  if (new Set(ids).size !== ids.length) throw new InvariantError('duplicate risk id in policy');
  assertKnownRiskIds(ctx.catalog, ids);
  for (const entry of policy) {
    if (!Number.isInteger(entry.quota) || entry.quota < 0) {
      throw new InvariantError(`quota must be a non-negative integer (${entry.riskId})`);
    }
    if (!Number.isInteger(entry.rateLimit) || entry.rateLimit < 0) {
      throw new InvariantError(`rate limit must be a non-negative integer (${entry.riskId})`);
    }
    if (!Number.isInteger(entry.rateWindowSeconds) || entry.rateWindowSeconds <= 0) {
      throw new InvariantError(`rate window must be a positive integer (${entry.riskId})`);
    }
  }
}

export function createMissionsRepo(ctx: RepoContext): MissionsRepo {
  const { db } = ctx;
  const byId = db.prepare<[string], MissionRow>(`SELECT ${COLUMNS} FROM missions WHERE id = ?`);
  const activeCount = db.prepare<[string], { readonly n: number }>(
    `SELECT COUNT(*) AS n FROM missions
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
  );
  const byCreator = db.prepare<[string], MissionRow>(
    `SELECT ${COLUMNS} FROM missions WHERE creator_user_id = ? ORDER BY created_at`,
  );
  const byMember = db.prepare<[string], MissionRow>(
    `SELECT m.id, m.name, m.creator_user_id, m.status, m.period_anchor, m.period_seconds,
       m.expires_at, m.delegation_id, m.created_at, m.updated_at, m.closed_at
     FROM missions m JOIN mission_members mm ON mm.mission_id = m.id
     WHERE mm.user_id = ? AND mm.removed_at IS NULL ORDER BY m.created_at`,
  );
  const byConnection = db.prepare<[string], MissionRow>(
    `SELECT m.id, m.name, m.creator_user_id, m.status, m.period_anchor, m.period_seconds,
       m.expires_at, m.delegation_id, m.created_at, m.updated_at, m.closed_at
     FROM missions m JOIN mission_connections mc ON mc.mission_id = m.id
     WHERE mc.connection_id = ? ORDER BY m.created_at`,
  );
  const insert = db.prepare<
    [string, string, string, string, number | null, string | null, string | null, string, string]
  >(
    `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, period_seconds,
       expires_at, delegation_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  );
  const insertConnection = db.prepare<[string, string, string, string | null]>(
    `INSERT INTO mission_connections (mission_id, connection_id, resource_scope, crans_json)
     VALUES (?, ?, ?, ?)`,
  );
  const insertResource = db.prepare<[string, string, string]>(
    'INSERT INTO mission_resources (mission_id, connection_id, resource_id) VALUES (?, ?, ?)',
  );
  const insertPolicy = db.prepare<[string, string, number, number, number, string]>(
    `INSERT INTO mission_policy (mission_id, risk_id, quota, rate_limit, rate_window_seconds, gate)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deletePolicy = db.prepare<[string]>('DELETE FROM mission_policy WHERE mission_id = ?');
  const policyOf = db.prepare<[string], PolicyRow>(
    `SELECT risk_id, quota, rate_limit, rate_window_seconds, gate FROM mission_policy
     WHERE mission_id = ? ORDER BY risk_id`,
  );
  const connectionsOf = db.prepare<[string], ConnectionRow>(
    'SELECT connection_id, resource_scope, crans_json FROM mission_connections WHERE mission_id = ? ORDER BY connection_id',
  );
  const resourcesOf = db.prepare<[string, string], SelectedRow>(
    'SELECT resource_id, source FROM mission_resources WHERE mission_id = ? AND connection_id = ? ORDER BY resource_id',
  );
  const scopeOf = db.prepare<[string, string], { resource_scope: string }>(
    'SELECT resource_scope FROM mission_connections WHERE mission_id = ? AND connection_id = ?',
  );
  const setScope = db.prepare<[string, string, string]>(
    'UPDATE mission_connections SET resource_scope = ? WHERE mission_id = ? AND connection_id = ?',
  );
  const insertResourceFrom = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_resources (mission_id, connection_id, resource_id, source)
     VALUES (?, ?, ?, ?) ON CONFLICT (mission_id, resource_id) DO NOTHING`,
  );
  const resourceConnectionOf = db.prepare<[string], { connection_id: string; ref: string }>(
    'SELECT connection_id, ref FROM connection_resources WHERE id = ?',
  );
  const setStatusStmt = db.prepare<[string, string | null, string, string]>(
    'UPDATE missions SET status = ?, closed_at = COALESCE(?, closed_at), updated_at = ? WHERE id = ?',
  );
  const setExpiry = db.prepare<[string | null, string, string]>(
    'UPDATE missions SET expires_at = ?, updated_at = ? WHERE id = ?',
  );
  const touch = db.prepare<[string, string]>('UPDATE missions SET updated_at = ? WHERE id = ?');
  const gateOf = db.prepare<[string, string], { gate: string }>(
    'SELECT gate FROM mission_policy WHERE mission_id = ? AND risk_id = ?',
  );
  const setGateStmt = db.prepare<[string, string, string]>(
    'UPDATE mission_policy SET gate = ? WHERE mission_id = ? AND risk_id = ?',
  );
  const limitsOf = db.prepare<
    [string, string],
    { quota: number; rate_limit: number; rate_window_seconds: number }
  >(
    'SELECT quota, rate_limit, rate_window_seconds FROM mission_policy WHERE mission_id = ? AND risk_id = ?',
  );
  const setLimitsStmt = db.prepare<[number, number, string, string]>(
    'UPDATE mission_policy SET quota = ?, rate_limit = ? WHERE mission_id = ? AND risk_id = ?',
  );
  // The session's events belong to the sessions repository: its primitives run here,
  // inside this repository's transaction.
  const sessions = createSessionPrimitives(ctx);
  // Rotation retires the token of ONE holder: the other holders keep working.
  const activeOfMember = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE mission_id = ? AND holder_user_id = ? AND kind = 'member' AND status = 'active'`,
  );
  const activeOfName = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE mission_id = ? AND name = ? AND kind = 'named' AND status = 'active'`,
  );
  const retireOne = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'rotated', retired_at = ? WHERE id = ? AND status = 'active'`,
  );
  const insertToken = db.prepare<
    [string, string, string, string, string, string, string | null, string | null, string, string]
  >(
    `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, kind,
       holder_user_id, name, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  );
  const tokenById = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE id = ?`,
  );
  const tokenByPrefix = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE prefix = ?`,
  );
  const tokensOf = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE mission_id = ? ORDER BY created_at`,
  );
  const revokeTokensStmt = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ? WHERE mission_id = ? AND status = 'active'`,
  );
  const revokeOne = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ? WHERE id = ? AND status = 'active'`,
  );
  const activeHeldAsMember = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE holder_user_id = ? AND kind = 'member' AND status = 'active'
       AND mission_id NOT IN (SELECT id FROM missions WHERE creator_user_id = ?)
     ORDER BY created_at`,
  );
  // Written only when the stored instant is older than the granularity: one statement,
  // so two concurrent calls write once.
  const markUsed = db.prepare<[string, string, string]>(
    `UPDATE mission_tokens SET last_used_at = ?
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  );
  const rehash = db.prepare<[string, string, string, string]>(
    'UPDATE mission_tokens SET hash = ?, hash_alg = ? WHERE id = ? AND hash = ?',
  );
  const memberOf = db.prepare<[string, string], MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM mission_members WHERE mission_id = ? AND user_id = ?`,
  );
  const membersOf = db.prepare<[string], MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM mission_members
     WHERE mission_id = ? AND removed_at IS NULL ORDER BY added_at, user_id`,
  );
  const upsertMember = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_members (mission_id, user_id, added_by, added_at, removed_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (mission_id, user_id)
     DO UPDATE SET added_by = excluded.added_by, added_at = excluded.added_at, removed_at = NULL`,
  );
  const markMemberRemoved = db.prepare<[string, string, string]>(
    `UPDATE mission_members SET removed_at = ?
     WHERE mission_id = ? AND user_id = ? AND removed_at IS NULL`,
  );

  const userStatus = db.prepare<[string], { status: string }>(
    'SELECT status FROM users WHERE id = ?',
  );
  /** The status of a user, as the membership rule reads it; `null` for an unknown user. */
  function userStatusOf(userId: string): { status: 'active' | 'removed' } | null {
    const row = userStatus.get(userId);
    return row ? { status: parseEnum(USER_STATUSES, row.status, 'users.status') } : null;
  }

  function requireToken(id: string): MissionTokenRecord {
    return tokenToRecord(requireRow(tokenById.get(id), 'mission_token', id));
  }

  function toRecord(row: MissionRow): MissionRecord {
    return {
      id: row.id,
      name: row.name,
      creatorUserId: row.creator_user_id,
      status: parseEnum(STORED_MISSION_STATUSES, row.status, 'missions.status'),
      periodAnchor: row.period_anchor,
      periodSeconds: row.period_seconds,
      expiresAt: row.expires_at,
      delegationId: row.delegation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      // perf: one query per connection; a Postgres port joins or aggregates instead.
      connections: connectionsOf
        .all(row.id)
        .map((c) => connectionToRecord(c, resourcesOf.all(row.id, c.connection_id))),
      policy: policyOf.all(row.id).map(policyToRecord),
    };
  }

  function requireMission(id: string): MissionRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('mission', id);
    return toRecord(row);
  }

  function writePolicy(missionId: string, policy: readonly MissionPolicyEntry[]): void {
    for (const p of policy) {
      insertPolicy.run(missionId, p.riskId, p.quota, p.rateLimit, p.rateWindowSeconds, p.gate);
    }
  }

  const renameStmt = db.prepare<[string, string]>('UPDATE missions SET name = ? WHERE id = ?');
  // Every expression of an UPDATE reads the row as it was: `closed_at` sees the old status.
  const reviveStmt = db.prepare<[string | null, string]>(
    `UPDATE missions SET expires_at = ?,
       status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
       closed_at = CASE WHEN status = 'expired' THEN NULL ELSE closed_at END
     WHERE id = ?`,
  );
  /** A resource row an edit adds: source `edit` (ADR mission-editable-after-issuance). */
  const insertEditedResource = db.prepare<[string, string, string]>(
    `INSERT INTO mission_resources (mission_id, connection_id, resource_id, source)
     VALUES (?, ?, ?, 'edit')`,
  );
  const rescopeStmt = db.prepare<[string, string, string]>(
    'UPDATE mission_connections SET resource_scope = ? WHERE mission_id = ? AND connection_id = ?',
  );
  const recranStmt = db.prepare<[string | null, string, string]>(
    'UPDATE mission_connections SET crans_json = ? WHERE mission_id = ? AND connection_id = ?',
  );
  const deleteConnectionStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_connections WHERE mission_id = ? AND connection_id = ?',
  );
  const deleteResourcesOfStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_resources WHERE mission_id = ? AND connection_id = ?',
  );
  const deleteResourceStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_resources WHERE mission_id = ? AND resource_id = ?',
  );
  const deleteLineStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_policy WHERE mission_id = ? AND risk_id = ?',
  );
  const updateLineStmt = db.prepare<[number, number, number, string, string, string]>(
    `UPDATE mission_policy SET quota = ?, rate_limit = ?, rate_window_seconds = ?, gate = ?
     WHERE mission_id = ? AND risk_id = ?`,
  );
  const openRequestsStmt = db.prepare<
    [string],
    { id: string; kind: string; risk_id: string; risk_ids_json: string | null }
  >(
    `SELECT id, kind, risk_id, risk_ids_json FROM requests
     WHERE mission_id = ? AND state = 'open' AND kind IN ('claim', 'approval')`,
  );
  const closeRequestStmt = db.prepare<[string, string, string, string]>(
    `UPDATE requests SET state = 'refused', decided_at = ?, decided_by_user_id = ?,
       decision_json = ?, args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  const retireApprovalsStmt = db.prepare<[string, string, string, string]>(
    `UPDATE approvals SET consumed_at = ? WHERE mission_id = ? AND consumed_at IS NULL
     AND (risk_id = ? OR EXISTS (SELECT 1 FROM json_each(approvals.risk_ids_json) WHERE value = ?))`,
  );

  function sameLimits(a: MissionPolicyEntry, b: MissionPolicyEntry): boolean {
    return (
      a.quota === b.quota &&
      a.rateLimit === b.rateLimit &&
      a.rateWindowSeconds === b.rateWindowSeconds
    );
  }

  /** The rows of one connection that move, and nothing else. In-transaction. */
  function writeSelection(
    missionId: string,
    old: MissionConnection | undefined,
    c: MissionConnection,
  ): void {
    if (!old) {
      insertConnection.run(missionId, c.connectionId, c.resourceScope, cransJsonOf(c));
      for (const resourceId of c.resourceIds)
        insertEditedResource.run(missionId, c.connectionId, resourceId);
      return;
    }
    if (old.resourceScope !== c.resourceScope) {
      rescopeStmt.run(c.resourceScope, missionId, c.connectionId);
    }
    const crans = cransJsonOf(c);
    if (crans !== cransJsonOf(old)) recranStmt.run(crans, missionId, c.connectionId);
    const had = new Set(old.resourceIds);
    const has = new Set(c.resourceIds);
    for (const resourceId of old.resourceIds) {
      if (!has.has(resourceId)) deleteResourceStmt.run(missionId, resourceId);
    }
    for (const resourceId of c.resourceIds) {
      if (!had.has(resourceId)) insertEditedResource.run(missionId, c.connectionId, resourceId);
    }
  }

  /** The open claims and approval requests about a removed risk, closed. In-transaction. */
  function closeMootRequests(
    missionId: string,
    gone: ReadonlySet<RiskId>,
    actorUserId: string,
    now: Iso,
    record: (event: NewEvent) => void,
  ): { id: string; kind: string }[] {
    const closed: { id: string; kind: string }[] = [];
    if (gone.size === 0) return closed;
    for (const row of openRequestsStmt.all(missionId)) {
      const listed = row.risk_ids_json ? (JSON.parse(row.risk_ids_json) as string[]) : [];
      const moot = [...new Set([row.risk_id, ...listed])].filter((r) => gone.has(r));
      if (moot.length === 0) continue;
      const decision = JSON.stringify({ resolution: 'mission-changed', removed: moot });
      if (closeRequestStmt.run(now, actorUserId, decision, row.id).changes === 0) continue;
      closed.push({ id: row.id, kind: row.kind });
      record({
        kind: 'request',
        riskId: row.risk_id,
        details: {
          request_id: row.id,
          request_kind: row.kind === 'claim' ? 'claim' : 'approval',
          state: 'refused',
          reason: 'mission-changed',
        },
      });
    }
    return closed;
  }

  return {
    async edit(id, input) {
      validatePolicy(ctx, input.policy);
      assertConnectionSelections(ctx, input.connections);
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const before = requireMission(id);
        if (
          before.creatorUserId !== input.actorUserId ||
          before.status === 'revoked' ||
          !input.unchanged(before)
        ) {
          return null;
        }
        if (before.name !== input.name) renameStmt.run(input.name, id);
        if (before.expiresAt !== input.expiresAt) {
          // An end moved into the future, or removed, brings an expired mission back.
          if (input.expiresAt === null || input.expiresAt > now)
            reviveStmt.run(input.expiresAt, id);
          else setExpiry.run(input.expiresAt, now, id);
        }

        const was = new Map(before.connections.map((c) => [c.connectionId, c]));
        const next = new Set(input.connections.map((c) => c.connectionId));
        for (const c of before.connections) {
          if (next.has(c.connectionId)) continue;
          deleteResourcesOfStmt.run(id, c.connectionId);
          deleteConnectionStmt.run(id, c.connectionId);
        }
        for (const c of input.connections) writeSelection(id, was.get(c.connectionId), c);

        const session = sessions.sessionOfMission(id);
        const record = (event: NewEvent): void => {
          if (session) sessions.recordEvent(session.id, event, now);
        };
        const actorUserId = input.actorUserId;
        const linesBefore = new Map(before.policy.map((p) => [p.riskId, p]));
        const linesAfter = new Set(input.policy.map((p) => p.riskId));
        const removed = before.policy.filter((p) => !linesAfter.has(p.riskId));
        for (const p of removed) {
          deleteLineStmt.run(id, p.riskId);
          // An approval must not survive the removal and re-addition of its risk.
          retireApprovalsStmt.run(now, id, p.riskId, p.riskId);
          record({
            kind: 'permission-removed',
            riskId: p.riskId,
            actorUserId,
            details: {
              quota: p.quota,
              rate_limit_max: p.rateLimit,
              rate_window_seconds: p.rateWindowSeconds,
              gate: p.gate,
            },
          });
        }
        for (const p of input.policy) {
          const old = linesBefore.get(p.riskId);
          if (!old) {
            insertPolicy.run(id, p.riskId, p.quota, p.rateLimit, p.rateWindowSeconds, p.gate);
            record({
              kind: 'permission-added',
              riskId: p.riskId,
              actorUserId,
              details: {
                quota: p.quota,
                rate_limit_max: p.rateLimit,
                rate_window_seconds: p.rateWindowSeconds,
                gate: p.gate,
              },
            });
            continue;
          }
          const limitsMove = !sameLimits(old, p);
          if (!limitsMove && old.gate === p.gate) continue;
          updateLineStmt.run(p.quota, p.rateLimit, p.rateWindowSeconds, p.gate, id, p.riskId);
          if (limitsMove) {
            const windowMoves = old.rateWindowSeconds !== p.rateWindowSeconds;
            record({
              kind: 'limits-changed',
              riskId: p.riskId,
              actorUserId,
              details: {
                quota: p.quota,
                quota_before: old.quota,
                rate_limit_max: p.rateLimit,
                rate_limit_max_before: old.rateLimit,
                ...(windowMoves
                  ? {
                      rate_window_seconds: p.rateWindowSeconds,
                      rate_window_seconds_before: old.rateWindowSeconds,
                    }
                  : {}),
              },
            });
          }
          if (old.gate !== p.gate) {
            record({
              kind: 'gate-changed',
              riskId: p.riskId,
              actorUserId,
              details: { gate: p.gate, gate_before: old.gate },
            });
          }
        }
        const gone = new Set(removed.map((p) => p.riskId));
        const closed = closeMootRequests(id, gone, actorUserId, now, record);
        touch.run(now, id);
        record(input.summary(closed.length));
        return { before, mission: requireMission(id), closedRequests: closed };
      });
    },
    async issuersOf(missionIds) {
      const issuers = new Map<string, MissionIssuerRecord>();
      const ids = [...new Set(missionIds)];
      if (ids.length === 0) return issuers;
      const rows = db
        .prepare<string[], IssuerRow>(
          `SELECT m.id AS mission_id, d.id AS delegation_id, c.client_id, c.name
           FROM missions m
             JOIN delegations d ON d.id = m.delegation_id
             JOIN oauth_clients c ON c.id = d.client_id
           WHERE m.id IN (${ids.map(() => '?').join(', ')})`,
        )
        .all(...ids);
      for (const row of rows) {
        issuers.set(row.mission_id, {
          missionId: row.mission_id,
          delegationId: row.delegation_id,
          clientId: row.client_id,
          clientName: row.name,
        });
      }
      return issuers;
    },
    async create(input) {
      validatePolicy(ctx, input.policy);
      assertConnectionSelections(ctx, input.connections);
      const id = ctx.newId();
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        insert.run(
          id,
          input.name,
          input.creatorUserId,
          input.periodAnchor ?? now,
          input.periodSeconds,
          input.expiresAt ?? null,
          input.delegationId ?? null,
          now,
          now,
        );
        for (const c of input.connections) {
          insertConnection.run(id, c.connectionId, c.resourceScope, cransJsonOf(c));
          for (const resourceId of c.resourceIds)
            insertResource.run(id, c.connectionId, resourceId);
        }
        writePolicy(id, input.policy);
      });
      return requireMission(id);
    },
    async addResources(missionId, connectionId, resourceIds, source, created) {
      if (!MISSION_RESOURCE_SOURCES.includes(source)) {
        throw new InvariantError(`unknown mission resource source '${String(source)}'`);
      }
      const now = nowIso(ctx);
      return withImmediateTransaction(db, (): AddedMissionResources => {
        const row = scopeOf.get(missionId, connectionId);
        if (!row) throw new NotFoundError('mission_connection', `${missionId}/${connectionId}`);
        const scope = parseEnum(
          RESOURCE_SCOPES,
          row.resource_scope,
          'mission_connections.resource_scope',
        );
        const refs: string[] = [];
        for (const resourceId of resourceIds) {
          const owner = resourceConnectionOf.get(resourceId);
          if (!owner) throw new NotFoundError('connection_resource', resourceId);
          if (owner.connection_id !== connectionId) {
            throw new InvariantError(
              `resource ${resourceId} does not belong to connection ${connectionId}`,
            );
          }
          if (!refs.includes(owner.ref)) refs.push(owner.ref);
        }
        const added: string[] = [];
        // Scope `connection` reaches every resource of the connection already.
        const writes = scope !== 'connection' && resourceIds.length > 0;
        if (writes) {
          // `all` stores no id only when nothing was known at issuance: with one, it is a list.
          if (scope === 'all') setScope.run('selected', missionId, connectionId);
          for (const resourceId of resourceIds) {
            if (added.includes(resourceId)) continue;
            if (insertResourceFrom.run(missionId, connectionId, resourceId, source).changes > 0) {
              added.push(resourceId);
            }
          }
          touch.run(now, missionId);
        }
        // What the mission created is in its activity, whatever the scope.
        const session =
          source === 'created' && created && refs.length > 0
            ? sessions.sessionOfMission(missionId)
            : null;
        if (session && created) {
          sessions.recordEvent(
            session.id,
            {
              kind: 'resources-created',
              actorUserId: created.actorUserId,
              details: { tool: created.tool, connection_id: connectionId, refs },
            },
            now,
          );
        }
        return { scope: writes ? 'selected' : scope, added };
      });
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async countActive(now) {
      return activeCount.get(now)?.n ?? 0;
    },
    async listForCreator(userId) {
      return byCreator.all(userId).map(toRecord);
    },
    async listForMember(userId) {
      return byMember.all(userId).map(toRecord);
    },
    async listForConnection(connectionId) {
      return byConnection.all(connectionId).map(toRecord);
    },
    async setStatus(id, status) {
      const now = nowIso(ctx);
      const terminal = status === 'revoked' || status === 'expired';
      const result = setStatusStmt.run(status, terminal ? now : null, now, id);
      if (result.changes === 0) throw new NotFoundError('mission', id);
      return requireMission(id);
    },
    async setExpiresAt(id, expiresAt) {
      const result = setExpiry.run(expiresAt, nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('mission', id);
      return requireMission(id);
    },
    async replacePolicy(id, policy) {
      validatePolicy(ctx, policy);
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        requireMission(id);
        deletePolicy.run(id);
        writePolicy(id, policy);
        touch.run(now, id);
        return requireMission(id);
      });
    },
    async changePermissions(id, policy, expected, actor, requestId) {
      validatePolicy(ctx, policy);
      const key = (lines: readonly MissionPolicyEntry[]) =>
        JSON.stringify(
          [...lines]
            .sort((a, b) => a.riskId.localeCompare(b.riskId))
            .map((p) => [p.riskId, p.quota, p.rateLimit, p.rateWindowSeconds, p.gate]),
        );
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        if (
          mission.creatorUserId !== actor ||
          mission.status === 'revoked' ||
          key(mission.policy) !== key(expected)
        )
          return null;
        const now = nowIso(ctx);
        if (requestId) {
          const request = db.prepare<[string, string, string], { risk_ids_json: string }>(
            "SELECT risk_ids_json FROM requests WHERE id = ? AND mission_id = ? AND kind = 'permission' AND state = 'open' AND expires_at > ?",
          );
          const row = request.get(requestId, id, now);
          if (!row) return null;
          const risks = JSON.parse(row.risk_ids_json) as string[];
          if (!risks.every((risk) => policy.some((p) => p.riskId === risk))) return null;
        }
        const removed = mission.policy.filter((p) => !policy.some((n) => n.riskId === p.riskId));
        deletePolicy.run(id);
        writePolicy(id, policy);
        touch.run(now, id);
        const session = sessions.sessionOfMission(id);
        if (session) {
          for (const p of removed)
            sessions.recordEvent(
              session.id,
              {
                kind: 'gate-changed',
                riskId: p.riskId,
                actorUserId: actor,
                details: { gate: 'approval', gate_before: p.gate },
              },
              now,
            );
          sessions.recordEvent(
            session.id,
            {
              kind: 'permissions-changed',
              actorUserId: actor,
              details: { before: mission.policy, after: policy, request_id: requestId ?? null },
            },
            now,
          );
        }
        // An unconsumed approval must not survive removal and re-addition of its risk.
        for (const p of removed) {
          db.prepare(
            `UPDATE approvals SET consumed_at = ? WHERE mission_id = ? AND consumed_at IS NULL
            AND (risk_id = ? OR EXISTS (SELECT 1 FROM json_each(approvals.risk_ids_json) WHERE value = ?))`,
          ).run(now, id, p.riskId, p.riskId);
        }
        if (requestId)
          db.prepare(
            `UPDATE requests SET state = 'granted', decided_at = ?, decided_by_user_id = ?,
          decision_json = ?, args_blob = NULL, key_version = NULL WHERE id = ?`,
          ).run(now, actor, JSON.stringify({ resolution: 'add-permissions' }), requestId);
        return requireMission(id);
      });
    },
    async setGate(id, riskId, gate, actorUserId, options = {}) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        const row = gateOf.get(id, riskId);
        if (!row) return null;
        const previous = parseEnum(GATES, row.gate, 'mission_policy.gate');
        const closing = previous === gate && gate === 'approval' && options.closeOpening === true;
        if (previous === gate && !closing) return { mission, previous, openingClosed: false };
        if (!closing) setGateStmt.run(gate, id, riskId);
        touch.run(now, id);
        const session = sessions.sessionOfMission(id);
        if (session) {
          sessions.recordEvent(
            session.id,
            {
              kind: 'gate-changed',
              riskId,
              actorUserId,
              details: { gate, gate_before: previous },
            } satisfies NewEvent,
            now,
          );
        }
        return {
          mission: requireMission(id),
          previous,
          openingClosed: closing && session !== null,
        };
      });
    },
    async setLimits(id, changes, actorUserId) {
      const ids = changes.map((c) => c.riskId);
      if (new Set(ids).size !== ids.length) throw new InvariantError('duplicate risk id in limits');
      for (const change of changes) {
        if (!Number.isInteger(change.quota) || change.quota < 0) {
          throw new InvariantError(`quota must be a non-negative integer (${change.riskId})`);
        }
        if (!Number.isInteger(change.rateLimit) || change.rateLimit < 0) {
          throw new InvariantError(`rate limit must be a non-negative integer (${change.riskId})`);
        }
      }
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        requireMission(id);
        const applied: AppliedLimitChange[] = [];
        for (const change of changes) {
          const row = limitsOf.get(id, change.riskId);
          if (!row) return null;
          const moved = row.quota !== change.quota || row.rate_limit !== change.rateLimit;
          applied.push({
            riskId: change.riskId,
            before: { quota: row.quota, rateLimit: row.rate_limit },
            after: { quota: change.quota, rateLimit: change.rateLimit },
            rateWindowSeconds: row.rate_window_seconds,
            changed: moved,
          });
        }
        const moved = applied.filter((a) => a.changed);
        if (moved.length === 0) return { mission: requireMission(id), changes: applied };
        for (const a of moved) setLimitsStmt.run(a.after.quota, a.after.rateLimit, id, a.riskId);
        touch.run(now, id);
        const session = sessions.sessionOfMission(id);
        if (session) {
          for (const a of moved) {
            sessions.recordEvent(
              session.id,
              {
                kind: 'limits-changed',
                riskId: a.riskId,
                actorUserId,
                details: {
                  quota: a.after.quota,
                  quota_before: a.before.quota,
                  rate_limit_max: a.after.rateLimit,
                  rate_limit_max_before: a.before.rateLimit,
                },
              } satisfies NewEvent,
              now,
            );
          }
        }
        return { mission: requireMission(id), changes: applied };
      });
    },
    async issueToken(input) {
      const id = ctx.newId();
      const now = nowIso(ctx);
      const { holder } = input;
      const replacedId = withImmediateTransaction(db, () => {
        const mission = requireMission(input.missionId);
        // The caller checked all of this before it computed the hash, which takes
        // tens of milliseconds: a revocation, a removal or a deactivation committed
        // meanwhile must not be undone by the insert. Checked again here, in the
        // transaction that writes.
        if (mission.status !== 'active') {
          throw new TokenNotIssuableError('mission-not-active', input.missionId);
        }
        let previous: TokenRow | undefined;
        if (holder.kind === 'member') {
          const row = memberOf.get(input.missionId, holder.userId);
          const membership = membershipOf(
            mission,
            holder.userId,
            userStatusOf(holder.userId),
            row ? { removedAt: row.removed_at } : null,
          );
          if (!isOnMission(membership)) {
            throw new TokenNotIssuableError('holder-not-a-member', input.missionId);
          }
          previous = activeOfMember.get(input.missionId, holder.userId);
          if (previous) retireOne.run(now, previous.id);
        } else if (input.replacing !== undefined) {
          const old = tokenById.get(input.replacing);
          if (
            !old ||
            old.mission_id !== input.missionId ||
            old.kind !== 'named' ||
            old.status !== 'active' ||
            old.name !== holder.name
          ) {
            throw new TokenNotIssuableError('token-not-replaceable', input.missionId);
          }
          retireOne.run(now, old.id);
          previous = old;
        } else if (activeOfName.get(input.missionId, holder.name)) {
          throw new TokenNotIssuableError('name-taken', input.missionId);
        }
        insertToken.run(
          id,
          input.missionId,
          input.prefix,
          input.hash,
          input.hashAlg,
          holder.kind,
          holder.kind === 'member' ? holder.userId : null,
          holder.kind === 'named' ? holder.name : null,
          input.createdBy,
          now,
        );
        return previous?.id ?? null;
      });
      return {
        token: requireToken(id),
        replaced: replacedId === null ? null : requireToken(replacedId),
      };
    },
    async findTokenByPrefix(prefix) {
      const row = tokenByPrefix.get(prefix);
      if (!row) return null;
      return { token: tokenToRecord(row), mission: requireMission(row.mission_id) };
    },
    async listTokens(missionId) {
      return tokensOf.all(missionId).map(tokenToRecord);
    },
    async getToken(tokenId) {
      const row = tokenById.get(tokenId);
      return row ? tokenToRecord(row) : null;
    },
    async revokeTokens(missionId) {
      return revokeTokensStmt.run(nowIso(ctx), missionId).changes;
    },
    async revokeToken(tokenId) {
      const changed = revokeOne.run(nowIso(ctx), tokenId).changes;
      return changed === 1 ? requireToken(tokenId) : null;
    },
    async revokeMemberTokensOf(userId) {
      const now = nowIso(ctx);
      const ids = withImmediateTransaction(db, () => {
        const held = activeHeldAsMember.all(userId, userId);
        return held.filter((row) => revokeOne.run(now, row.id).changes === 1).map((row) => row.id);
      });
      return ids.map(requireToken);
    },
    async markTokenUsed(tokenId, granularitySeconds) {
      const stale = new Date(ctx.clock.now().getTime() - granularitySeconds * MS_PER_SECOND);
      return markUsed.run(nowIso(ctx), tokenId, stale.toISOString()).changes === 1;
    },
    async rehashToken(tokenId, change) {
      return rehash.run(change.hash, change.hashAlg, tokenId, change.fromHash).changes === 1;
    },
    async addMember(input) {
      const now = nowIso(ctx);
      const staleId = withImmediateTransaction(db, () => {
        const mission = requireMission(input.missionId);
        if (mission.creatorUserId === input.userId) {
          throw new InvariantError('the creator is a member by construction, never a member row');
        }
        // A member starts with no token. A working row found here predates this
        // membership (it should not exist: removal revokes, and `issueToken` refuses
        // a holder who is not on the mission): it is revoked with the same write.
        const stale = activeOfMember.get(input.missionId, input.userId);
        if (stale) revokeOne.run(now, stale.id);
        upsertMember.run(input.missionId, input.userId, input.addedBy, now);
        return stale?.id ?? null;
      });
      return {
        member: memberToRecord(
          requireRow(memberOf.get(input.missionId, input.userId), 'mission_member', input.userId),
        ),
        tokenRevoked: staleId === null ? null : requireToken(staleId),
      };
    },
    async removeMember(missionId, userId) {
      const now = nowIso(ctx);
      const revokedId = withImmediateTransaction(db, () => {
        if (markMemberRemoved.run(now, missionId, userId).changes === 0) return undefined;
        const held = activeOfMember.get(missionId, userId);
        if (!held) return null;
        revokeOne.run(now, held.id);
        return held.id;
      });
      if (revokedId === undefined) return null;
      return {
        member: memberToRecord(
          requireRow(memberOf.get(missionId, userId), 'mission_member', userId),
        ),
        tokenRevoked: revokedId === null ? null : requireToken(revokedId),
      };
    },
    async getMember(missionId, userId) {
      const row = memberOf.get(missionId, userId);
      return row ? memberToRecord(row) : null;
    },
    async listMembers(missionId) {
      return membersOf.all(missionId).map(memberToRecord);
    },
  };
}
