/**
 * Audit repository — append, read, and the only legitimate purge path.
 *
 * Spec §6 "immutable audit", §8 (fields, 90-day default retention). Entries are
 * `@vaubaan/gateway-core`'s `AuditEntry` (P0.5). The schema's triggers abort every
 * UPDATE and every DELETE that happens outside a purge window; `purgeOlderThan` opens
 * that window inside its own transaction.
 */

import type {
  AdminAuditEntry,
  AuditDecision,
  AuditEntry,
  CallAuditEntry,
} from '@vaubaan/gateway-core';
import { isRefusalCode, type RefusalCode, type Slice } from '@vaubaan/shared';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError } from '../errors.ts';
import type { Iso, Principal, RiskId } from '../types.ts';
import {
  DEFAULT_LIST_LIMIT,
  MS_PER_DAY,
  parseEnum,
  parseJson,
  placeholders,
  principalPredicate,
  requireColumn,
  requireRow,
  toJson,
  type RepoContext,
} from './context.ts';
import { ADMIN_ACTS, ADMIN_OBJECT_TYPES, AUDIT_DECISIONS, AUDIT_KINDS } from './enums.ts';

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

/** One `audit_risks` row: a risk's place in the call entry. */
export interface AuditRiskRow {
  readonly riskId: RiskId;
  /** In the mission's accepted risks at call time (snapshot). */
  readonly accepted: boolean;
  /** Touched by this call. */
  readonly touched: boolean;
  /** Remaining budget after the call, when known. */
  readonly remaining: number | null;
}

export type AuditRecord =
  | ({ readonly id: string; readonly risks: readonly AuditRiskRow[] } & CallAuditEntry)
  | ({ readonly id: string } & AdminAuditEntry);

export interface AuditFilter {
  readonly missionId?: string;
  readonly kind?: 'call' | 'admin';
  readonly since?: Iso;
  readonly until?: Iso;
  readonly limit?: number;
}

/**
 * Whose audit a search may return (spec §4.2 "Audit", §6): the entries about the
 * missions one user created and about the connections some principals own, plus —
 * for an operator — every administrative entry. A search always carries a scope;
 * an empty one (`missionCreatorUserId: null`, no owner, `allAdmin: false`) matches
 * nothing.
 */
export interface AuditScope {
  /** Entries about the missions this user created (calls, acts on them, their requests). */
  readonly missionCreatorUserId: string | null;
  /** Entries about the connections these principals own (calls through them, acts on them). */
  readonly connectionOwners: readonly Principal[];
  /** Every administrative entry, whatever its object. */
  readonly allAdmin: boolean;
}

/** Keyset position: the last entry of the previous page (`ts`, then `id`). */
export interface AuditCursor {
  readonly ts: Iso;
  readonly id: string;
}

export type AuditCallRecord = Extract<AuditRecord, { readonly kind: 'call' }>;

export interface CallLookup {
  readonly missionId: string;
  readonly tool: string;
  /** `arguments_hash`: the canonical fingerprint of the call's arguments. */
  readonly argumentsHash: string;
  /** Only entries refused with this code. */
  readonly refusalCode?: RefusalCode;
}

export interface AuditSearch {
  readonly scope: AuditScope;
  /** Calls of the mission, administrative acts on it and on its requests. */
  readonly missionId?: string;
  /** Acts performed by these users and calls of the missions they created. An empty
   *  list matches nothing. */
  readonly userIds?: readonly string[];
  /** Calls through the connection and administrative acts on it. */
  readonly connectionId?: string;
  /** Exact tool name (call entries only). */
  readonly tool?: string;
  /** Call entries only. */
  readonly decision?: AuditDecision;
  readonly kind?: 'call' | 'admin';
  /** `ts >= since`. */
  readonly since?: Iso;
  /** `ts < until`. */
  readonly until?: Iso;
  /** Entries strictly older than this position (newest first). */
  readonly before?: AuditCursor;
  readonly limit: number;
}

/** One agent label seen on a mission's calls (attribution only, spec §3.3). */
export interface AgentLabelSeen {
  readonly label: string;
  readonly calls: number;
  readonly lastSeenAt: Iso;
}

export interface AuditRepo {
  append(entry: AuditEntry): Promise<AuditRecord>;
  getById(id: string): Promise<AuditRecord | null>;
  list(filter?: AuditFilter): Promise<AuditRecord[]>;
  /**
   * The Audit page's query: scoped, filtered, newest first (`ts DESC, id DESC`), paged
   * by keyset. Returns at most `limit` records.
   */
  search(query: AuditSearch): Promise<AuditRecord[]>;
  /**
   * The most recent call entry of a mission for one tool and one argument fingerprint —
   * what the creator's view of an approval request reads the slices and the touched
   * risks from (spec §3.5: "only their fingerprint remains in the audit").
   */
  latestCall(query: CallLookup): Promise<AuditCallRecord | null>;
  /** Distinct agent labels of a mission's call entries, most recently seen first. */
  agentLabels(missionId: string): Promise<AgentLabelSeen[]>;
  /**
   * Allowed call entries touching `riskId` in `[since, until)` — the audit side of the
   * structural check "session counters agree with the audit" (spec §10).
   */
  countAllowedTouches(missionId: string, riskId: RiskId, since: Iso, until: Iso): Promise<number>;
  /** Retention purge: deletes entries strictly older than `cutoff`. The only delete path. */
  purgeOlderThan(cutoff: Iso): Promise<number>;
  /** `purgeOlderThan(now - retentionDays)`; default 90 days (spec §8). */
  purgeByRetention(retentionDays?: number): Promise<number>;
}

interface AuditRow {
  id: string;
  ts: string;
  kind: string;
  mission_id: string | null;
  session_id: string | null;
  connection_id: string | null;
  resource_ref: string | null;
  tool: string | null;
  arguments_hash: string | null;
  slices_json: string | null;
  decision: string | null;
  refusal_code: string | null;
  refusal_reason: string | null;
  approval_id: string | null;
  agent_label: string | null;
  upstream_latency_ms: number | null;
  upstream_error: string | null;
  client_ip: string | null;
  client_user_agent: string | null;
  user_id: string | null;
  act: string | null;
  object_type: string | null;
  object_id: string | null;
  before_json: string | null;
  after_json: string | null;
  delegated_client_id: string | null;
}

interface RiskRow {
  risk_id: string;
  accepted: number;
  touched: number;
  remaining: number | null;
}

/** The one ordered column list: SELECTs, the INSERT and its parameters derive from it. */
const AUDIT_COLUMNS = [
  'id',
  'ts',
  'kind',
  'mission_id',
  'session_id',
  'connection_id',
  'resource_ref',
  'tool',
  'arguments_hash',
  'slices_json',
  'decision',
  'refusal_code',
  'refusal_reason',
  'approval_id',
  'agent_label',
  'upstream_latency_ms',
  'upstream_error',
  'client_ip',
  'client_user_agent',
  'user_id',
  'act',
  'object_type',
  'object_id',
  'before_json',
  'after_json',
  'delegated_client_id',
] as const satisfies readonly (keyof AuditRow)[];
type AuditColumn = (typeof AUDIT_COLUMNS)[number];
const COLUMNS = AUDIT_COLUMNS.join(', ');

type SqlParams = (string | number | null)[];

/** Positional parameters in `AUDIT_COLUMNS` order; columns the entry kind does not set are null. */
function toParams(values: Partial<Record<AuditColumn, string | number | null>>): SqlParams {
  return AUDIT_COLUMNS.map((column) => values[column] ?? null);
}

function callParams(id: string, e: CallAuditEntry): SqlParams {
  return toParams({
    id,
    ts: e.ts,
    kind: 'call',
    mission_id: e.mission_id,
    session_id: e.session_id,
    connection_id: e.connection_id,
    resource_ref: e.resource_ref,
    tool: e.tool,
    arguments_hash: e.arguments_hash,
    slices_json: toJson(e.slices_executed),
    decision: e.decision,
    refusal_code: e.refusal_code,
    refusal_reason: e.refusal_reason,
    approval_id: e.approval_id,
    agent_label: e.agent_label,
    upstream_latency_ms: e.upstream_latency_ms,
    upstream_error: e.upstream_error,
    client_ip: e.client_ip,
    client_user_agent: e.client_user_agent,
  });
}

function adminParams(id: string, e: AdminAuditEntry): SqlParams {
  return toParams({
    id,
    ts: e.ts,
    kind: 'admin',
    user_id: e.user_id,
    act: e.act,
    object_type: e.object.type,
    object_id: e.object.id,
    before_json: toJson(e.before ?? null),
    after_json: toJson(e.after ?? null),
    delegated_client_id: e.delegated_client_id,
  });
}

function isSlice(value: unknown): value is Slice {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { provider?: unknown; path?: unknown; action?: unknown };
  return (
    typeof v.provider === 'string' &&
    Array.isArray(v.path) &&
    (v.action === 'R' || v.action === 'W')
  );
}

function parseSlices(text: string | null): Slice[] {
  const value = parseJson(text);
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(isSlice)) {
    throw new InvariantError('audit.slices_json: expected a list of slices');
  }
  return value;
}

function riskToRecord(row: RiskRow): AuditRiskRow {
  return {
    riskId: row.risk_id,
    accepted: row.accepted === 1,
    touched: row.touched === 1,
    remaining: row.remaining,
  };
}

/** One row per risk in the accepted snapshot or touched by the call. */
function riskRows(e: CallAuditEntry): AuditRiskRow[] {
  const accepted = new Set(e.accepted_risks_snapshot);
  const touched = new Set(e.risks_touched);
  const all = [...new Set([...e.accepted_risks_snapshot, ...e.risks_touched])].sort();
  return all.map((riskId) => ({
    riskId,
    accepted: accepted.has(riskId),
    touched: touched.has(riskId),
    remaining: e.remaining_budget?.[riskId] ?? null,
  }));
}

const REQUESTS_OF_MISSION = 'SELECT id FROM requests WHERE mission_id';

/**
 * The WHERE clause of `search`: the scope first (what the viewer may see at all), then
 * the filters, then the keyset position. Plain subqueries and `IN` lists only, so the
 * statement is the same on Postgres.
 */
function searchStatement(query: AuditSearch): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };

  const { scope } = query;
  const owners = principalPredicate(scope.connectionOwners, 'owner_user_id', 'owner_group_id');
  // No creator in the scope: an always-false subquery, as `principalPredicate` does for
  // an empty owner list, rather than a placeholder value that happens to match nothing.
  const creator = scope.missionCreatorUserId === null ? [] : [scope.missionCreatorUserId];
  const ownMissions = `SELECT id FROM missions WHERE ${creator.length ? 'creator_user_id = ?' : '1 = 0'}`;
  const ownConnections = `SELECT id FROM connections WHERE ${owners.sql}`;
  add(
    `(
      (kind = 'call' AND (mission_id IN (${ownMissions}) OR connection_id IN (${ownConnections})))
      OR (kind = 'admin' AND (
        ${scope.allAdmin ? '1 = 1' : '1 = 0'}
        OR (object_type = 'mission' AND object_id IN (${ownMissions}))
        OR (object_type = 'connection' AND object_id IN (${ownConnections}))
        OR (object_type = 'request' AND object_id IN (${REQUESTS_OF_MISSION} IN (${ownMissions})))
      ))
    )`,
    ...creator,
    ...owners.params,
    ...creator,
    ...owners.params,
    ...creator,
  );

  if (query.missionId) {
    add(
      `(mission_id = ?
        OR (object_type = 'mission' AND object_id = ?)
        OR (object_type = 'request' AND object_id IN (${REQUESTS_OF_MISSION} = ?)))`,
      query.missionId,
      query.missionId,
      query.missionId,
    );
  }
  if (query.userIds) {
    const ids = query.userIds;
    if (ids.length === 0) add('1 = 0');
    else {
      const list = placeholders(ids.length);
      add(
        `(user_id IN (${list})
          OR mission_id IN (SELECT id FROM missions WHERE creator_user_id IN (${list})))`,
        ...ids,
        ...ids,
      );
    }
  }
  if (query.connectionId) {
    add(
      "(connection_id = ? OR (object_type = 'connection' AND object_id = ?))",
      query.connectionId,
      query.connectionId,
    );
  }
  if (query.tool) add('tool = ?', query.tool);
  if (query.decision) add('decision = ?', query.decision);
  if (query.kind) add('kind = ?', query.kind);
  if (query.since) add('ts >= ?', query.since);
  if (query.until) add('ts < ?', query.until);
  if (query.before) {
    add('(ts < ? OR (ts = ? AND id < ?))', query.before.ts, query.before.ts, query.before.id);
  }
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    throw new InvariantError('audit search: limit must be a positive integer');
  }
  params.push(query.limit);
  return {
    sql: `SELECT ${COLUMNS} FROM audit WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
    params,
  };
}

export function createAuditRepo(ctx: RepoContext): AuditRepo {
  const { db } = ctx;
  const insert = db.prepare<SqlParams>(
    `INSERT INTO audit (${COLUMNS}) VALUES (${placeholders(AUDIT_COLUMNS.length)})`,
  );
  const insertRisk = db.prepare<[string, string, number, number, number | null]>(
    'INSERT INTO audit_risks (audit_id, risk_id, accepted, touched, remaining) VALUES (?, ?, ?, ?, ?)',
  );
  const byId = db.prepare<[string], AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE id = ?`);
  const risksOf = db.prepare<[string], RiskRow>(
    'SELECT risk_id, accepted, touched, remaining FROM audit_risks WHERE audit_id = ? ORDER BY risk_id',
  );
  const countTouches = db.prepare<[string, string, string, string], { n: number }>(
    `SELECT COUNT(*) AS n FROM audit a JOIN audit_risks r ON r.audit_id = a.id
     WHERE a.kind = 'call' AND a.decision = 'allowed' AND a.mission_id = ?
       AND r.risk_id = ? AND r.touched = 1 AND a.ts >= ? AND a.ts < ?`,
  );
  const openWindow = db.prepare<[string]>(
    'INSERT INTO audit_purge_guard (id, cutoff) VALUES (1, ?)',
  );
  const closeWindow = db.prepare<[]>('DELETE FROM audit_purge_guard WHERE id = 1');
  const purgeRisks = db.prepare<[string]>(
    'DELETE FROM audit_risks WHERE audit_id IN (SELECT id FROM audit WHERE ts < ?)',
  );
  const purge = db.prepare<[string]>('DELETE FROM audit WHERE ts < ?');
  const labelsOf = db.prepare<[string], { label: string; calls: number; last_seen: string }>(
    `SELECT agent_label AS label, COUNT(*) AS calls, MAX(ts) AS last_seen FROM audit
     WHERE kind = 'call' AND mission_id = ? AND agent_label IS NOT NULL
     GROUP BY agent_label ORDER BY last_seen DESC, agent_label`,
  );

  const latestCallOf = db.prepare<[string, string, string], AuditRow>(
    `SELECT ${COLUMNS} FROM audit
     WHERE kind = 'call' AND mission_id = ? AND tool = ? AND arguments_hash = ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
  );
  const latestRefusedCallOf = db.prepare<[string, string, string, string], AuditRow>(
    `SELECT ${COLUMNS} FROM audit
     WHERE kind = 'call' AND mission_id = ? AND tool = ? AND arguments_hash = ? AND refusal_code = ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
  );

  function toRecord(row: AuditRow): AuditRecord {
    const kind = parseEnum(AUDIT_KINDS, row.kind, 'audit.kind');
    return kind === 'admin' ? toAdminRecord(row) : toCallRecord(row);
  }

  function toAdminRecord(row: AuditRow): AuditRecord {
    // `act` and `object_type` have no schema CHECK: the lists written from gateway-core's
    // unions are the only guard, so a value the code does not know is refused here.
    return {
      id: row.id,
      kind: 'admin',
      ts: row.ts,
      user_id: requireColumn(row.user_id, 'audit.user_id'),
      act: parseEnum(ADMIN_ACTS, requireColumn(row.act, 'audit.act'), 'audit.act'),
      object: {
        type: parseEnum(
          ADMIN_OBJECT_TYPES,
          requireColumn(row.object_type, 'audit.object_type'),
          'audit.object_type',
        ),
        id: requireColumn(row.object_id, 'audit.object_id'),
      },
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      delegated_client_id: row.delegated_client_id,
    };
  }

  function toCallRecord(row: AuditRow): AuditCallRecord {
    // perf: one query per call entry; a Postgres port reads a page's risks in one statement.
    const risks = risksOf.all(row.id).map(riskToRecord);
    const remaining = risks.filter((r) => r.remaining !== null);
    const refusalCode = row.refusal_code;
    if (refusalCode !== null && !isRefusalCode(refusalCode)) {
      throw new InvariantError(`audit.refusal_code: unexpected value '${refusalCode}'`);
    }
    return {
      id: row.id,
      kind: 'call',
      ts: row.ts,
      mission_id: requireColumn(row.mission_id, 'audit.mission_id'),
      session_id: row.session_id,
      connection_id: row.connection_id,
      resource_ref: row.resource_ref,
      tool: requireColumn(row.tool, 'audit.tool'),
      arguments_hash: requireColumn(row.arguments_hash, 'audit.arguments_hash'),
      slices_executed: parseSlices(row.slices_json),
      risks_touched: risks.filter((r) => r.touched).map((r) => r.riskId),
      accepted_risks_snapshot: risks.filter((r) => r.accepted).map((r) => r.riskId),
      decision: parseEnum(
        AUDIT_DECISIONS,
        requireColumn(row.decision, 'audit.decision'),
        'audit.decision',
      ),
      refusal_code: refusalCode,
      refusal_reason: row.refusal_reason,
      approval_id: row.approval_id,
      remaining_budget: remaining.length
        ? Object.fromEntries(remaining.map((r) => [r.riskId, r.remaining ?? 0]))
        : null,
      agent_label: row.agent_label,
      upstream_latency_ms: row.upstream_latency_ms,
      upstream_error: row.upstream_error,
      client_ip: row.client_ip,
      client_user_agent: row.client_user_agent,
      risks,
    };
  }

  function requireEntry(id: string): AuditRecord {
    return toRecord(requireRow(byId.get(id), 'audit', id));
  }

  async function purgeOlderThan(cutoff: Iso): Promise<number> {
    return withImmediateTransaction(db, () => {
      openWindow.run(cutoff);
      try {
        purgeRisks.run(cutoff);
        return purge.run(cutoff).changes;
      } finally {
        closeWindow.run();
      }
    });
  }

  return {
    async append(entry) {
      const id = ctx.newId();
      const params = entry.kind === 'call' ? callParams(id, entry) : adminParams(id, entry);
      const risks = entry.kind === 'call' ? riskRows(entry) : [];
      withImmediateTransaction(db, () => {
        insert.run(...params);
        for (const r of risks) {
          insertRisk.run(id, r.riskId, r.accepted ? 1 : 0, r.touched ? 1 : 0, r.remaining);
        }
      });
      return requireEntry(id);
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async list(filter = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.missionId) {
        where.push('mission_id = ?');
        params.push(filter.missionId);
      }
      if (filter.kind) {
        where.push('kind = ?');
        params.push(filter.kind);
      }
      if (filter.since) {
        where.push('ts >= ?');
        params.push(filter.since);
      }
      if (filter.until) {
        where.push('ts < ?');
        params.push(filter.until);
      }
      params.push(filter.limit ?? DEFAULT_LIST_LIMIT);
      const sql = `SELECT ${COLUMNS} FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts, id LIMIT ?`;
      return db
        .prepare<(string | number)[], AuditRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async search(query) {
      const { sql, params } = searchStatement(query);
      return db
        .prepare<(string | number)[], AuditRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async latestCall(query) {
      const row = query.refusalCode
        ? latestRefusedCallOf.get(
            query.missionId,
            query.tool,
            query.argumentsHash,
            query.refusalCode,
          )
        : latestCallOf.get(query.missionId, query.tool, query.argumentsHash);
      return row ? toCallRecord(row) : null;
    },
    async agentLabels(missionId) {
      return labelsOf
        .all(missionId)
        .map((r) => ({ label: r.label, calls: r.calls, lastSeenAt: r.last_seen }));
    },
    async countAllowedTouches(missionId, riskId, since, until) {
      return countTouches.get(missionId, riskId, since, until)?.n ?? 0;
    },
    purgeOlderThan,
    async purgeByRetention(retentionDays = DEFAULT_AUDIT_RETENTION_DAYS) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        throw new InvariantError('retention must be a positive number of days');
      }
      const cutoff = new Date(ctx.clock.now().getTime() - retentionDays * MS_PER_DAY);
      return purgeOlderThan(cutoff.toISOString());
    },
  };
}
