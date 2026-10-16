import { withImmediateTransaction } from '../db.ts';
import { InvariantError } from '../errors.ts';
import type { ApprovalRecord, Iso, RiskId } from '../types.ts';
import { nowIso, requireRow, type RepoContext } from './context.ts';

/**
 * The call an approval is bound to (spec §3.5, migrations 0005 and 0013): within its
 * mission, the tool and the canonical fingerprint of the arguments. The same arguments
 * sent to another tool are another call, and ask again. An approval then lists the
 * gated risks of that call it covers (`riskIds`).
 */
export interface ApprovedCall {
  readonly tool: string;
  readonly fingerprint: string;
}

export interface CreateApprovalInput extends ApprovedCall {
  readonly missionId: string;
  readonly requestId: string;
  /** Every gated risk of the call the approval covers; never empty. */
  readonly riskIds: readonly RiskId[];
  readonly expiresAt: Iso;
}

/**
 * The risks a row lists. A row with no list, or one that cannot be read, covers the one
 * risk of its `risk_id` column and nothing more: the narrow reading.
 */
export function riskIdsOf(riskId: RiskId, json: string | null): readonly RiskId[] {
  if (json === null) return [riskId];
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item): item is string => typeof item === 'string' && item.length > 0)
    ) {
      return parsed;
    }
  } catch {
    // Falls through to the narrow reading.
  }
  return [riskId];
}

/** What a request or an approval about several risks stores: the list, the first as `risk_id`. */
export function riskIdsColumn(riskIds: readonly RiskId[]): { riskId: RiskId; json: string } {
  const distinct = [...new Set(riskIds)];
  const [first] = distinct;
  if (first === undefined) throw new InvariantError('a request or an approval names a risk');
  return { riskId: first, json: JSON.stringify(distinct) };
}

export interface ApprovalsRepo {
  create(input: CreateApprovalInput): Promise<ApprovalRecord>;
  /** The approval a granted request produced; null when it was refused, or not granted yet. */
  getByRequest(requestId: string): Promise<ApprovalRecord | null>;
  /** Unconsumed, unexpired approvals of the mission. */
  listActive(missionId: string): Promise<ApprovalRecord[]>;
}

interface ApprovalRow {
  id: string;
  mission_id: string;
  request_id: string;
  risk_id: string;
  risk_ids_json: string | null;
  tool: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const COLUMNS =
  'id, mission_id, request_id, risk_id, risk_ids_json, tool, fingerprint, created_at, expires_at, consumed_at';

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    requestId: row.request_id,
    riskId: row.risk_id,
    riskIds: riskIdsOf(row.risk_id, row.risk_ids_json),
    tool: row.tool,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM approvals WHERE id = ?`;
const SELECT_FOR_CALL = `SELECT ${COLUMNS} FROM approvals
  WHERE mission_id = ? AND tool = ? AND fingerprint = ?
    AND consumed_at IS NULL AND expires_at > ?
  ORDER BY expires_at, id`;
const CONSUME = `UPDATE approvals SET consumed_at = ?
  WHERE id = ? AND mission_id = ? AND consumed_at IS NULL AND expires_at > ?`;
const INSERT = `INSERT INTO approvals (id, mission_id, request_id, risk_id, risk_ids_json, tool, fingerprint, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function getApprovalRecord(ctx: RepoContext, id: string): ApprovalRecord | null {
  const row = ctx.db.prepare<[string], ApprovalRow>(SELECT_BY_ID).get(id);
  return row ? toRecord(row) : null;
}

/**
 * Synchronous non-consuming lookup, meant to run inside an already-open write
 * transaction: every usable approval of the mission for this call — same tool, same
 * fingerprint, not consumed, not expired — soonest-expiring first. The budget decision
 * reads which gated risks they cover before consuming anything, so a call refused on one
 * risk leaves every approval untouched.
 */
export function findApprovalsSync(
  ctx: RepoContext,
  missionId: string,
  call: ApprovedCall,
  now: Iso,
): ApprovalRecord[] {
  // A row older than migration 0005 has an empty tool: it must match no call.
  if (call.tool === '') return [];
  // perf: prepared on every call (the driver keeps no statement cache). Cheap in-process;
  // a hot path would prepare these once in the factory and pass them in.
  return ctx.db
    .prepare<[string, string, string, string], ApprovalRow>(SELECT_FOR_CALL)
    .all(missionId, call.tool, call.fingerprint, now)
    .map(toRecord);
}

/**
 * Synchronous consumption of one approval by id, meant to run inside an already-open
 * write transaction. `null`, and nothing written, when the approval is not this
 * mission's, is already consumed or has expired: an approval is used once.
 */
export function consumeApprovalSync(
  ctx: RepoContext,
  missionId: string,
  approvalId: string,
  now: Iso,
): ApprovalRecord | null {
  const result = ctx.db
    .prepare<[string, string, string, string]>(CONSUME)
    .run(now, approvalId, missionId, now);
  if (result.changes === 0) return null;
  return getApprovalRecord(ctx, approvalId);
}

/**
 * Synchronous insert, meant to run inside an already-open write transaction: the
 * creator's grant writes the approval in the transaction that decides the request.
 */
export function insertApprovalSync(
  ctx: RepoContext,
  input: CreateApprovalInput,
  now: Iso,
): ApprovalRecord {
  if (input.tool === '') throw new InvariantError('an approval is bound to a tool');
  const risks = riskIdsColumn(input.riskIds);
  const id = ctx.newId();
  ctx.db
    .prepare<[string, string, string, string, string, string, string, string, string]>(INSERT)
    .run(
      id,
      input.missionId,
      input.requestId,
      risks.riskId,
      risks.json,
      input.tool,
      input.fingerprint,
      now,
      input.expiresAt,
    );
  return requireRow(getApprovalRecord(ctx, id) ?? undefined, 'approval', id);
}

export function createApprovalsRepo(ctx: RepoContext): ApprovalsRepo {
  const { db } = ctx;
  const active = db.prepare<[string, string], ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals WHERE mission_id = ? AND consumed_at IS NULL AND expires_at > ?
     ORDER BY expires_at`,
  );
  const byRequest = db.prepare<[string], ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals WHERE request_id = ?`,
  );

  return {
    async create(input) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => insertApprovalSync(ctx, input, now));
    },
    async getByRequest(requestId) {
      const row = byRequest.get(requestId);
      return row ? toRecord(row) : null;
    },
    async listActive(missionId) {
      return active.all(missionId, nowIso(ctx)).map(toRecord);
    },
  };
}
