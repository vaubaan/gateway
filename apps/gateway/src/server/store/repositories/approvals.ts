import { withImmediateTransaction } from '../db.ts';
import { InvariantError } from '../errors.ts';
import type { ApprovalRecord, Iso, RiskId } from '../types.ts';
import { nowIso, requireRow, type RepoContext } from './context.ts';

/**
 * What an approval is bound to (spec §3.5, migration 0005): within its mission, the
 * risk, the tool and the canonical fingerprint of the arguments. The same arguments
 * sent to another tool that touches the same risk are another call, and ask again.
 */
export interface ApprovalKey {
  readonly riskId: RiskId;
  readonly tool: string;
  readonly fingerprint: string;
}

export interface CreateApprovalInput extends ApprovalKey {
  readonly missionId: string;
  readonly requestId: string;
  readonly expiresAt: Iso;
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
  tool: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const COLUMNS =
  'id, mission_id, request_id, risk_id, tool, fingerprint, created_at, expires_at, consumed_at';

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    requestId: row.request_id,
    riskId: row.risk_id,
    tool: row.tool,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM approvals WHERE id = ?`;
const SELECT_CANDIDATE = `SELECT id FROM approvals
  WHERE mission_id = ? AND risk_id = ? AND tool = ? AND fingerprint = ?
    AND consumed_at IS NULL AND expires_at > ?
  ORDER BY expires_at LIMIT 1`;
const CONSUME = 'UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL';
const INSERT = `INSERT INTO approvals (id, mission_id, request_id, risk_id, tool, fingerprint, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function getApprovalRecord(ctx: RepoContext, id: string): ApprovalRecord | null {
  const row = ctx.db.prepare<[string], ApprovalRow>(SELECT_BY_ID).get(id);
  return row ? toRecord(row) : null;
}

function candidateId(
  ctx: RepoContext,
  missionId: string,
  key: ApprovalKey,
  now: Iso,
): string | null {
  // A row older than migration 0005 has an empty tool: it must match no call.
  if (key.tool === '') return null;
  // perf: prepared on every call (the driver keeps no statement cache). Cheap in-process;
  // a hot path would prepare these once in the factory and pass them in.
  const candidate = ctx.db
    .prepare<[string, string, string, string, string], { id: string }>(SELECT_CANDIDATE)
    .get(missionId, key.riskId, key.tool, key.fingerprint, now);
  return candidate?.id ?? null;
}

/**
 * Synchronous non-consuming lookup, meant to run inside an already-open write
 * transaction: the budget decision checks every gated risk before consuming anything,
 * so a call refused on one risk leaves the approvals of the others untouched.
 */
export function findApprovalSync(
  ctx: RepoContext,
  missionId: string,
  key: ApprovalKey,
  now: Iso,
): ApprovalRecord | null {
  const id = candidateId(ctx, missionId, key, now);
  return id ? getApprovalRecord(ctx, id) : null;
}

/**
 * Synchronous consumption, meant to run inside an already-open write transaction.
 * Picks the soonest-expiring valid approval so a later grant stays usable.
 */
export function consumeApprovalSync(
  ctx: RepoContext,
  missionId: string,
  key: ApprovalKey,
  now: Iso,
): ApprovalRecord | null {
  const id = candidateId(ctx, missionId, key, now);
  if (!id) return null;
  const result = ctx.db.prepare<[string, string]>(CONSUME).run(now, id);
  if (result.changes === 0) return null;
  return getApprovalRecord(ctx, id);
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
  const id = ctx.newId();
  ctx.db
    .prepare<[string, string, string, string, string, string, string, string]>(INSERT)
    .run(
      id,
      input.missionId,
      input.requestId,
      input.riskId,
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
