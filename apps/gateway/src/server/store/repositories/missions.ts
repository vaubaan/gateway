import { assertKnownRiskIds } from '../catalog-index.ts';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import {
  MISSION_TOKEN_STATUSES,
  RESOURCE_SCOPES,
  type Gate,
  type Iso,
  type MissionConnection,
  type MissionIssuerRecord,
  type MissionPolicyEntry,
  type MissionRecord,
  type MissionStatus,
  type MissionTokenRecord,
  type NewEvent,
  type RiskId,
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
}

/** What the `missions.status` column may hold: every `MissionStatus` but the derived one. */
export type StoredMissionStatus = Exclude<MissionStatus, 'orphaned'>;

export interface MissionsRepo {
  create(input: CreateMissionInput): Promise<MissionRecord>;
  getById(id: string): Promise<MissionRecord | null>;
  listForCreator(userId: string): Promise<MissionRecord[]>;
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
  /** Issues a new token; the previously active one, if any, becomes `rotated`. */
  issueToken(input: IssueTokenInput): Promise<MissionTokenRecord>;
  findTokenByPrefix(
    prefix: string,
  ): Promise<{ token: MissionTokenRecord; mission: MissionRecord } | null>;
  listTokens(missionId: string): Promise<MissionTokenRecord[]>;
  /** Revokes every non-retired token of the mission; returns how many were revoked. */
  revokeTokens(missionId: string): Promise<number>;
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
}

interface TokenRow {
  id: string;
  mission_id: string;
  prefix: string;
  hash: string;
  hash_alg: string;
  status: string;
  created_at: string;
  retired_at: string | null;
}

const COLUMNS = `id, name, creator_user_id, status, period_anchor, period_seconds, expires_at,
  delegation_id, created_at, updated_at, closed_at`;
const TOKEN_COLUMNS = 'id, mission_id, prefix, hash, hash_alg, status, created_at, retired_at';

function tokenToRecord(row: TokenRow): MissionTokenRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    prefix: row.prefix,
    hash: row.hash,
    hashAlg: row.hash_alg,
    status: parseEnum(MISSION_TOKEN_STATUSES, row.status, 'mission_tokens.status'),
    createdAt: row.created_at,
    retiredAt: row.retired_at,
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

function connectionToRecord(row: ConnectionRow, resourceIds: string[]): MissionConnection {
  return {
    connectionId: row.connection_id,
    resourceScope: parseEnum(
      RESOURCE_SCOPES,
      row.resource_scope,
      'mission_connections.resource_scope',
    ),
    resourceIds,
  };
}

/** Every connection either takes all its resources or an explicit, consistent selection. */
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
    if (c.resourceScope === 'all' && c.resourceIds.length > 0) {
      throw new InvariantError(`connection ${c.connectionId}: 'all' scope lists resources`);
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
  const byCreator = db.prepare<[string], MissionRow>(
    `SELECT ${COLUMNS} FROM missions WHERE creator_user_id = ? ORDER BY created_at`,
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
  const insertConnection = db.prepare<[string, string, string]>(
    'INSERT INTO mission_connections (mission_id, connection_id, resource_scope) VALUES (?, ?, ?)',
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
    'SELECT connection_id, resource_scope FROM mission_connections WHERE mission_id = ? ORDER BY connection_id',
  );
  const resourcesOf = db.prepare<[string, string], { resource_id: string }>(
    'SELECT resource_id FROM mission_resources WHERE mission_id = ? AND connection_id = ? ORDER BY resource_id',
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
  // The session's events belong to the sessions repository: its primitives run here,
  // inside this repository's transaction.
  const sessions = createSessionPrimitives(ctx);
  const retireActive = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'rotated', retired_at = ? WHERE mission_id = ? AND status = 'active'`,
  );
  const insertToken = db.prepare<[string, string, string, string, string, string]>(
    `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
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
      connections: connectionsOf.all(row.id).map((c) =>
        connectionToRecord(
          c,
          resourcesOf.all(row.id, c.connection_id).map((r) => r.resource_id),
        ),
      ),
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

  return {
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
          insertConnection.run(id, c.connectionId, c.resourceScope);
          for (const resourceId of c.resourceIds)
            insertResource.run(id, c.connectionId, resourceId);
        }
        writePolicy(id, input.policy);
      });
      return requireMission(id);
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async listForCreator(userId) {
      return byCreator.all(userId).map(toRecord);
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
    async issueToken(input) {
      const id = ctx.newId();
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        requireMission(input.missionId);
        retireActive.run(now, input.missionId);
        insertToken.run(id, input.missionId, input.prefix, input.hash, input.hashAlg, now);
      });
      return tokenToRecord(requireRow(tokenById.get(id), 'mission_token', id));
    },
    async findTokenByPrefix(prefix) {
      const row = tokenByPrefix.get(prefix);
      if (!row) return null;
      return { token: tokenToRecord(row), mission: requireMission(row.mission_id) };
    },
    async listTokens(missionId) {
      return tokensOf.all(missionId).map(tokenToRecord);
    },
    async revokeTokens(missionId) {
      return revokeTokensStmt.run(nowIso(ctx), missionId).changes;
    },
  };
}
