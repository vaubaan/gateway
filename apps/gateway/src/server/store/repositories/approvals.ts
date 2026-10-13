import { withImmediateTransaction } from '../db.ts';
import type { ApprovalRecord, Iso, RiskId } from '../types.ts';
import { nowIso, requireRow, type RepoContext } from './context.ts';

export interface CreateApprovalInput {
  readonly missionId: string;
  readonly requestId: string;
  readonly riskId: RiskId;
  readonly fingerprint: string;
  readonly expiresAt: Iso;
}

export interface ApprovalsRepo {
  create(input: CreateApprovalInput): Promise<ApprovalRecord>;
  getById(id: string): Promise<ApprovalRecord | null>;
  /** Unconsumed, unexpired approvals of the mission. */
  listActive(missionId: string): Promise<ApprovalRecord[]>;
  /**
   * Single-use consumption of the approval matching `(mission, risk, fingerprint)`.
   * Returns the consumed approval, or null when none is valid. Inside a decision
   * transaction use `DecideContext.consumeApproval` instead.
   */
  consume(missionId: string, riskId: RiskId, fingerprint: string): Promise<ApprovalRecord | null>;
}

interface ApprovalRow {
  id: string;
  mission_id: string;
  request_id: string;
  risk_id: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const COLUMNS =
  'id, mission_id, request_id, risk_id, fingerprint, created_at, expires_at, consumed_at';

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    requestId: row.request_id,
    riskId: row.risk_id,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM approvals WHERE id = ?`;
const SELECT_CANDIDATE = `SELECT id FROM approvals
  WHERE mission_id = ? AND risk_id = ? AND fingerprint = ? AND consumed_at IS NULL AND expires_at > ?
  ORDER BY expires_at LIMIT 1`;
const CONSUME = 'UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL';

function getApprovalRecord(ctx: RepoContext, id: string): ApprovalRecord | null {
  const row = ctx.db.prepare<[string], ApprovalRow>(SELECT_BY_ID).get(id);
  return row ? toRecord(row) : null;
}

/**
 * Synchronous non-consuming lookup, meant to run inside an already-open write
 * transaction: the budget decision checks every gated risk before consuming anything,
 * so a call refused on one risk leaves the approvals of the others untouched.
 */
export function findApprovalSync(
  ctx: RepoContext,
  missionId: string,
  riskId: RiskId,
  fingerprint: string,
  now: Iso,
): ApprovalRecord | null {
  const candidate = ctx.db
    .prepare<[string, string, string, string], { id: string }>(SELECT_CANDIDATE)
    .get(missionId, riskId, fingerprint, now);
  return candidate ? getApprovalRecord(ctx, candidate.id) : null;
}

/**
 * Synchronous consumption, meant to run inside an already-open write transaction.
 * Picks the soonest-expiring valid approval so a later grant stays usable.
 */
export function consumeApprovalSync(
  ctx: RepoContext,
  missionId: string,
  riskId: RiskId,
  fingerprint: string,
  now: Iso,
): ApprovalRecord | null {
  // perf: prepared on every call (the driver keeps no statement cache). Cheap in-process;
  // a hot path would prepare these once in the factory and pass them in.
  const candidate = ctx.db
    .prepare<[string, string, string, string], { id: string }>(SELECT_CANDIDATE)
    .get(missionId, riskId, fingerprint, now);
  if (!candidate) return null;
  const result = ctx.db.prepare<[string, string]>(CONSUME).run(now, candidate.id);
  if (result.changes === 0) return null;
  return getApprovalRecord(ctx, candidate.id);
}

export function createApprovalsRepo(ctx: RepoContext): ApprovalsRepo {
  const { db } = ctx;
  const insert = db.prepare<[string, string, string, string, string, string, string]>(
    `INSERT INTO approvals (id, mission_id, request_id, risk_id, fingerprint, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const active = db.prepare<[string, string], ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals WHERE mission_id = ? AND consumed_at IS NULL AND expires_at > ?
     ORDER BY expires_at`,
  );

  return {
    async create(input) {
      const id = ctx.newId();
      insert.run(
        id,
        input.missionId,
        input.requestId,
        input.riskId,
        input.fingerprint,
        nowIso(ctx),
        input.expiresAt,
      );
      return requireRow(getApprovalRecord(ctx, id) ?? undefined, 'approval', id);
    },
    async getById(id) {
      return getApprovalRecord(ctx, id);
    },
    async listActive(missionId) {
      return active.all(missionId, nowIso(ctx)).map(toRecord);
    },
    async consume(missionId, riskId, fingerprint) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () =>
        consumeApprovalSync(ctx, missionId, riskId, fingerprint, now),
      );
    },
  };
}
