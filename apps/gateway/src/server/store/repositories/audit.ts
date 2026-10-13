/**
 * Audit repository — append, read, and the only legitimate purge path.
 *
 * Spec §6 "immutable audit", §8 (fields, 90-day default retention). Entries are
 * `@vaubaan/gateway-core`'s `AuditEntry` (P0.5). The schema's triggers abort every
 * UPDATE and every DELETE that happens outside a purge window; `purgeOlderThan` opens
 * that window inside its own transaction.
 */

import type {
  AdminAct,
  AdminAuditEntry,
  AdminObjectType,
  AuditDecision,
  AuditEntry,
  CallAuditEntry,
} from '@vaubaan/gateway-core';
import { isRefusalCode, type Slice } from '@vaubaan/shared';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError } from '../errors.ts';
import type { Iso, RiskId } from '../types.ts';
import {
  DEFAULT_LIST_LIMIT,
  MS_PER_DAY,
  parseEnum,
  parseJson,
  placeholders,
  requireColumn,
  requireRow,
  toJson,
  type RepoContext,
} from './context.ts';

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const AUDIT_DECISIONS = ['allowed', 'refused'] as const satisfies readonly AuditDecision[];

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

export interface AuditRepo {
  append(entry: AuditEntry): Promise<AuditRecord>;
  getById(id: string): Promise<AuditRecord | null>;
  list(filter?: AuditFilter): Promise<AuditRecord[]>;
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

  function toRecord(row: AuditRow): AuditRecord {
    return row.kind === 'admin' ? toAdminRecord(row) : toCallRecord(row);
  }

  function toAdminRecord(row: AuditRow): AuditRecord {
    // `act` and `object_type` have no schema CHECK: gateway-core's unions are the only
    // definition, so the store trusts what it wrote (the writer is typed).
    return {
      id: row.id,
      kind: 'admin',
      ts: row.ts,
      user_id: requireColumn(row.user_id, 'audit.user_id'),
      act: requireColumn(row.act, 'audit.act') as AdminAct,
      object: {
        type: requireColumn(row.object_type, 'audit.object_type') as AdminObjectType,
        id: requireColumn(row.object_id, 'audit.object_id'),
      },
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      delegated_client_id: row.delegated_client_id,
    };
  }

  function toCallRecord(row: AuditRow): AuditRecord {
    const risks: AuditRiskRow[] = risksOf.all(row.id).map((r) => ({
      riskId: r.risk_id,
      accepted: r.accepted === 1,
      touched: r.touched === 1,
      remaining: r.remaining,
    }));
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
