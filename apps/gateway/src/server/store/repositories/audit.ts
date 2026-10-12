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
  RefusalCode,
} from '@vaubaan/gateway-core';
import type { Slice } from '@vaubaan/shared';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type { Iso, RiskId } from '../types.ts';
import { parseJson, toJson, type RepoContext } from './context.ts';

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

const COLUMNS = `id, ts, kind, mission_id, session_id, connection_id, resource_ref, tool, arguments_hash,
  slices_json, decision, refusal_code, refusal_reason, approval_id, agent_label, upstream_latency_ms,
  upstream_error, client_ip, client_user_agent, user_id, act, object_type, object_id, before_json,
  after_json, delegated_client_id`;
const COLUMN_COUNT = 26;

type SqlParams = (string | number | null)[];

function callParams(id: string, e: CallAuditEntry): SqlParams {
  return [
    id,
    e.ts,
    'call',
    e.mission_id,
    e.session_id,
    e.connection_id,
    e.resource_ref,
    e.tool,
    e.arguments_hash,
    toJson(e.slices_executed),
    e.decision,
    e.refusal_code,
    e.refusal_reason,
    e.approval_id,
    e.agent_label,
    e.upstream_latency_ms,
    e.upstream_error,
    e.client_ip,
    e.client_user_agent,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
}

function adminParams(id: string, e: AdminAuditEntry): SqlParams {
  return [
    id,
    e.ts,
    'admin',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    e.user_id,
    e.act,
    e.object.type,
    e.object.id,
    toJson(e.before ?? null),
    toJson(e.after ?? null),
    e.delegated_client_id,
  ];
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
    `INSERT INTO audit (${COLUMNS}) VALUES (${Array.from({ length: COLUMN_COUNT }, () => '?').join(', ')})`,
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
    if (row.kind === 'admin') {
      return {
        id: row.id,
        kind: 'admin',
        ts: row.ts,
        user_id: row.user_id ?? '',
        act: row.act as AdminAct,
        object: { type: row.object_type as AdminObjectType, id: row.object_id ?? '' },
        before: parseJson<unknown>(row.before_json),
        after: parseJson<unknown>(row.after_json),
        delegated_client_id: row.delegated_client_id,
      };
    }
    const risks: AuditRiskRow[] = risksOf.all(row.id).map((r) => ({
      riskId: r.risk_id,
      accepted: r.accepted === 1,
      touched: r.touched === 1,
      remaining: r.remaining,
    }));
    const remaining = risks.filter((r) => r.remaining !== null);
    return {
      id: row.id,
      kind: 'call',
      ts: row.ts,
      mission_id: row.mission_id ?? '',
      session_id: row.session_id,
      connection_id: row.connection_id,
      resource_ref: row.resource_ref,
      tool: row.tool ?? '',
      arguments_hash: row.arguments_hash ?? '',
      slices_executed: parseJson<Slice[]>(row.slices_json) ?? [],
      risks_touched: risks.filter((r) => r.touched).map((r) => r.riskId),
      accepted_risks_snapshot: risks.filter((r) => r.accepted).map((r) => r.riskId),
      decision: row.decision as AuditDecision,
      refusal_code: row.refusal_code as RefusalCode | null,
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

  function require(id: string): AuditRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('audit', id);
    return toRecord(row);
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
      return require(id);
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
      params.push(filter.limit ?? 1000);
      const sql = `SELECT ${COLUMNS} FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts, id LIMIT ?`;
      return db
        .prepare<(string | number)[], AuditRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async countAllowedTouches(missionId, riskId, since, until) {
      return countTouches.get(missionId, riskId, since, until)?.n ?? 0;
    },
    async purgeOlderThan(cutoff) {
      return withImmediateTransaction(db, () => {
        openWindow.run(cutoff);
        try {
          purgeRisks.run(cutoff);
          return purge.run(cutoff).changes;
        } finally {
          closeWindow.run();
        }
      });
    },
    async purgeByRetention(retentionDays = DEFAULT_AUDIT_RETENTION_DAYS) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        throw new InvariantError('retention must be a positive number of days');
      }
      const cutoff = new Date(ctx.clock.now().getTime() - retentionDays * 86_400_000);
      return this.purgeOlderThan(cutoff.toISOString());
    },
  };
}
