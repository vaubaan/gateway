import { withImmediateTransaction } from '../db.ts';
import { openText, sealText, type Encryptor } from '../encryptor.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type { Iso, RequestKind, RequestRecord, RequestState, RiskId } from '../types.ts';
import { nowIso, parseJson, toJson, type RepoContext } from './context.ts';

/**
 * Approval-request arguments sealed ahead of a transaction. The request id is fixed
 * here because it is the associated data of the blob; `createRequest` inside
 * `decideAndDecrement` (synchronous) consumes the prepared value.
 */
export interface PreparedArguments {
  readonly requestId: string;
  readonly blob: Buffer;
  readonly keyVersion: number;
}

export interface RequestInput {
  readonly missionId: string;
  readonly sessionId?: string | null;
  readonly kind: RequestKind;
  readonly riskId: RiskId;
  /** Approval requests: the tool and the canonical-argument fingerprint are mandatory. */
  readonly tool?: string | null;
  readonly fingerprint?: string | null;
  readonly expiresAt: Iso;
}

/** Input of the asynchronous `create`: clear arguments, sealed by the repository. */
export interface CreateRequestInput extends RequestInput {
  readonly arguments?: unknown;
}

/** Input of the synchronous in-transaction insert: arguments already sealed. */
export interface InsertRequestInput extends RequestInput {
  readonly prepared?: PreparedArguments | null;
}

export interface RequestsRepo {
  create(input: CreateRequestInput): Promise<RequestRecord>;
  /** Seals arguments for a request that a decision transaction will drop. */
  prepareArguments(args: unknown): Promise<PreparedArguments>;
  getById(id: string): Promise<RequestRecord | null>;
  /** Open requests addressed to the creator of their mission (the inbox). */
  listOpenForCreator(userId: string): Promise<RequestRecord[]>;
  listForMission(missionId: string): Promise<RequestRecord[]>;
  /** Decrypts the held arguments for the creator's page; null once erased. */
  getArguments(id: string): Promise<unknown>;
  /** Grants or refuses an open request and erases the argument blob. */
  decide(
    id: string,
    state: 'granted' | 'refused',
    decidedByUserId: string,
    decision?: Record<string, unknown> | null,
  ): Promise<RequestRecord>;
  /** Sweeper: flips open requests past their expiry to `expired` and erases blobs. */
  expireOpen(): Promise<number>;
}

interface RequestRow {
  id: string;
  mission_id: string;
  session_id: string | null;
  kind: string;
  state: string;
  risk_id: string;
  tool: string | null;
  fingerprint: string | null;
  has_args: number;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
  decision_json: string | null;
}

const COLUMNS = `r.id, r.mission_id, r.session_id, r.kind, r.state, r.risk_id, r.tool, r.fingerprint,
  CASE WHEN r.args_blob IS NULL THEN 0 ELSE 1 END AS has_args, r.created_at, r.expires_at,
  r.decided_at, r.decided_by_user_id, r.decision_json`;

function toRecord(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    sessionId: row.session_id,
    kind: row.kind as RequestKind,
    state: row.state as RequestState,
    riskId: row.risk_id,
    tool: row.tool,
    fingerprint: row.fingerprint,
    hasArguments: row.has_args === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedByUserId: row.decided_by_user_id,
    decision: parseJson<Record<string, unknown>>(row.decision_json),
  };
}

export function requestAd(id: string): string {
  return `request:${id}`;
}

export async function prepareRequestArguments(
  encryptor: Encryptor,
  requestId: string,
  args: unknown,
): Promise<PreparedArguments> {
  const sealed = await sealText(encryptor, requestAd(requestId), JSON.stringify(args));
  return { requestId, blob: sealed.blob, keyVersion: sealed.keyVersion };
}

export function getRequestRecord(ctx: RepoContext, id: string): RequestRecord | null {
  const row = ctx.db
    .prepare<[string], RequestRow>(`SELECT ${COLUMNS} FROM requests r WHERE r.id = ?`)
    .get(id);
  return row ? toRecord(row) : null;
}

/** Synchronous insert, meant to run inside an already-open write transaction. */
export function insertRequestSync(
  ctx: RepoContext,
  input: InsertRequestInput,
  now: Iso,
): RequestRecord {
  if (input.kind === 'approval' && (!input.tool || !input.fingerprint)) {
    throw new InvariantError('an approval request carries a tool and a fingerprint');
  }
  const id = input.prepared?.requestId ?? ctx.newId();
  ctx.db
    .prepare<
      [
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        Buffer | null,
        number | null,
        string,
        string,
      ]
    >(
      `INSERT INTO requests (id, mission_id, session_id, kind, state, risk_id, tool, fingerprint,
         args_blob, key_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.missionId,
      input.sessionId ?? null,
      input.kind,
      input.riskId,
      input.tool ?? null,
      input.fingerprint ?? null,
      input.prepared?.blob ?? null,
      input.prepared?.keyVersion ?? null,
      now,
      input.expiresAt,
    );
  const record = getRequestRecord(ctx, id);
  if (!record) throw new NotFoundError('request', id);
  return record;
}

export function createRequestsRepo(ctx: RepoContext): RequestsRepo {
  const { db } = ctx;
  const openForCreator = db.prepare<[string], RequestRow>(
    `SELECT ${COLUMNS} FROM requests r JOIN missions m ON m.id = r.mission_id
     WHERE r.state = 'open' AND m.creator_user_id = ? ORDER BY r.created_at`,
  );
  const forMission = db.prepare<[string], RequestRow>(
    `SELECT ${COLUMNS} FROM requests r WHERE r.mission_id = ? ORDER BY r.created_at`,
  );
  const blobOf = db.prepare<[string], { args_blob: Buffer | null; key_version: number | null }>(
    'SELECT args_blob, key_version FROM requests WHERE id = ?',
  );
  const decide = db.prepare<[string, string, string, string | null, string]>(
    `UPDATE requests SET state = ?, decided_at = ?, decided_by_user_id = ?, decision_json = ?,
       args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  const expire = db.prepare<[string]>(
    `UPDATE requests SET state = 'expired', args_blob = NULL, key_version = NULL
     WHERE state = 'open' AND expires_at <= ?`,
  );

  async function prepareArguments(args: unknown): Promise<PreparedArguments> {
    return prepareRequestArguments(ctx.encryptor, ctx.newId(), args);
  }

  return {
    prepareArguments,
    async create(input) {
      const { arguments: args, ...rest } = input;
      const prepared = args === undefined ? null : await prepareArguments(args);
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => insertRequestSync(ctx, { ...rest, prepared }, now));
    },
    async getById(id) {
      return getRequestRecord(ctx, id);
    },
    async listOpenForCreator(userId) {
      return openForCreator.all(userId).map(toRecord);
    },
    async listForMission(missionId) {
      return forMission.all(missionId).map(toRecord);
    },
    async getArguments(id) {
      const row = blobOf.get(id);
      if (!row) throw new NotFoundError('request', id);
      if (!row.args_blob || row.key_version === null) return null;
      const text = await openText(ctx.encryptor, requestAd(id), {
        blob: row.args_blob,
        keyVersion: row.key_version,
      });
      return JSON.parse(text) as unknown;
    },
    async decide(id, state, decidedByUserId, decision = null) {
      const current = getRequestRecord(ctx, id);
      if (!current) throw new NotFoundError('request', id);
      if (current.state !== 'open') {
        throw new InvariantError(`request ${id} is already ${current.state}`);
      }
      decide.run(state, nowIso(ctx), decidedByUserId, toJson(decision), id);
      const updated = getRequestRecord(ctx, id);
      if (!updated) throw new NotFoundError('request', id);
      return updated;
    },
    async expireOpen() {
      return expire.run(nowIso(ctx)).changes;
    },
  };
}
