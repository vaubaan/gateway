import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText, type Encryptor } from '../encryptor.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type {
  ApprovalRecord,
  EventRecord,
  Iso,
  MissionStatus,
  NewEvent,
  RequestKind,
  RequestRecord,
  RiskId,
  SessionRecord,
} from '../types.ts';
import { insertApprovalSync } from './approvals.ts';
import {
  nowIso,
  parseEnum,
  parseJsonObject,
  requireRow,
  toJson,
  type RepoContext,
} from './context.ts';
import { REQUEST_KINDS, REQUEST_STATES, STORED_MISSION_STATUSES } from './enums.ts';
import { createSessionPrimitives, type RiskEventQuery } from './sessions.ts';

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

/**
 * The fields of the request's mission a decision is checked against, as the store
 * holds them inside the decision's transaction: a rule checked on them and the write
 * that follows see the same row. `status` is the stored one, never `orphaned` (that
 * verdict is derived by the caller, before the transaction).
 */
export interface StoredMissionFacts {
  readonly status: Exclude<MissionStatus, 'orphaned'>;
  readonly expiresAt: Iso | null;
}

/**
 * What the `apply` callback of `decideClaim` sees and may do, all inside the open
 * transaction. The rules (which resolution, which amount, which date) belong to the
 * `RequestService`; this context only makes their effects atomic with the decision.
 */
export interface ClaimDecisionContext {
  /** The claim, still `open` and unexpired at `now`. */
  readonly request: RequestRecord;
  /** The claim's mission as stored, read inside this transaction. */
  readonly mission: StoredMissionFacts;
  /** The mission's session; null only when the session row was deleted since. */
  readonly session: SessionRecord | null;
  readonly now: Iso;
  /** Consumed count per risk in the period starting at `periodStart`. */
  counters(periodStart: Iso): ReadonlyMap<RiskId, number>;
  /** Sets every counter of the period to zero; returns what each one held. */
  resetCounters(periodStart: Iso): ReadonlyMap<RiskId, number>;
  /** Gives `amount` actions back on one risk; false (nothing written) when fewer were consumed. */
  creditCounter(periodStart: Iso, riskId: RiskId, amount: number): boolean;
  /** Moves the mission's expiry; a mission stored `expired` becomes `active` again. */
  setMissionExpiry(expiresAt: Iso): void;
  /** Records an event on the mission's session; null when there is no session. */
  recordEvent(event: NewEvent): EventRecord | null;
}

export interface RequestDecisionOutcome {
  readonly state: 'granted' | 'refused';
  /** Persisted in `requests.decision_json` (resolution, amounts, dates). Never arguments. */
  readonly decision: Record<string, unknown>;
}

export type RequestDecisionResult<R extends RequestDecisionOutcome> =
  | { readonly status: 'decided'; readonly request: RequestRecord; readonly outcome: R }
  /** Already granted, refused or expired (an overdue open request is expired here). */
  | { readonly status: 'not-open'; readonly request: RequestRecord };

export type ClaimDecisionOutcome = RequestDecisionOutcome;
export type ClaimDecisionResult<R extends ClaimDecisionOutcome> = RequestDecisionResult<R>;

/**
 * What the `apply` callback of `decideApproval` sees and may do, all inside the open
 * transaction (spec §3.5). The rules (grant, refuse, open the gate) belong to the
 * `RequestService`; this context makes their effects atomic with the decision and with
 * the erasure of the sealed arguments.
 */
export interface ApprovalDecisionContext {
  /** The approval request, still `open` and unexpired at `now`. */
  readonly request: RequestRecord;
  /** The request's mission as stored, read inside this transaction. */
  readonly mission: StoredMissionFacts;
  /** The mission's session; null only when the session row was deleted since. */
  readonly session: SessionRecord | null;
  readonly now: Iso;
  /**
   * The approval a grant produces: bound to the request's mission, risk, tool and
   * fingerprint, single-use, valid until `expiresAt`.
   */
  createApproval(expiresAt: Iso): ApprovalRecord;
  /** Events of the mission's session about some risks (empty when there is no session). */
  riskEvents(query: RiskEventQuery): EventRecord[];
  /** Records an event on the mission's session; null when there is no session. */
  recordEvent(event: NewEvent): EventRecord | null;
}

export interface RequestsRepo {
  create(input: CreateRequestInput): Promise<RequestRecord>;
  /** Seals arguments for a request that a decision transaction will drop. */
  prepareArguments(args: unknown): Promise<PreparedArguments>;
  getById(id: string): Promise<RequestRecord | null>;
  /** Open requests addressed to the creator of their mission (the inbox). */
  listOpenForCreator(userId: string): Promise<RequestRecord[]>;
  listForMission(missionId: string): Promise<RequestRecord[]>;
  /**
   * Decrypts the held arguments for the creator's page. Null once erased, and null for
   * a request that is no longer open — decided, or past its expiry even when the
   * sweeper has not erased the blob yet.
   */
  getArguments(id: string): Promise<unknown>;
  /**
   * Decides an open claim and applies the creator's resolution in one `BEGIN IMMEDIATE`
   * transaction: the state change, the counter / expiry effects done through the
   * context, and the events. `apply` must be synchronous; if it throws, nothing is
   * written. A request that is not a claim is an `InvariantError`.
   */
  decideClaim<R extends ClaimDecisionOutcome>(
    id: string,
    decidedByUserId: string,
    apply: (ctx: ClaimDecisionContext) => R,
  ): Promise<ClaimDecisionResult<R>>;
  /**
   * Decides an open approval request in one `BEGIN IMMEDIATE` transaction: the state
   * change, the erasure of the sealed arguments, the approval or the gate opening done
   * through the context, and the events. `apply` must be synchronous; if it throws,
   * nothing is written and the arguments stay sealed. A request that is not an approval
   * request is an `InvariantError`.
   */
  decideApproval<R extends RequestDecisionOutcome>(
    id: string,
    decidedByUserId: string,
    apply: (ctx: ApprovalDecisionContext) => R,
  ): Promise<RequestDecisionResult<R>>;
  /**
   * Sweeper: flips open requests past their expiry to `expired`, erases their sealed
   * arguments, and records one `request` event (`state: 'expired'`) per request on its
   * mission's session. Returns the expired requests.
   */
  sweepExpired(): Promise<RequestRecord[]>;
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
    kind: parseEnum(REQUEST_KINDS, row.kind, 'requests.kind'),
    state: parseEnum(REQUEST_STATES, row.state, 'requests.state'),
    riskId: row.risk_id,
    tool: row.tool,
    fingerprint: row.fingerprint,
    hasArguments: row.has_args === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedByUserId: row.decided_by_user_id,
    decision: parseJsonObject(row.decision_json, 'requests.decision_json'),
  };
}

function requestAd(id: string): string {
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

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM requests r WHERE r.id = ?`;
const INSERT_OPEN = `INSERT INTO requests (id, mission_id, session_id, kind, state, risk_id, tool, fingerprint,
    args_blob, key_version, created_at, expires_at)
  VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`;

function getRequestRecord(ctx: RepoContext, id: string): RequestRecord | null {
  const row = ctx.db.prepare<[string], RequestRow>(SELECT_BY_ID).get(id);
  return row ? toRecord(row) : null;
}

export interface OpenRequestLookup {
  readonly kind: RequestKind;
  readonly riskId: RiskId;
  /**
   * Approval requests are keyed by the call too — its tool and the fingerprint of its
   * arguments, both mandatory for them; claims ignore both.
   */
  readonly tool?: string | null;
  readonly fingerprint?: string | null;
}

// Two statements rather than one with `? IS NULL OR r.fingerprint = ?`: Postgres cannot
// infer the type of a parameter that is only compared to NULL.
const OPEN_OF_RISK = `r.mission_id = ? AND r.kind = ? AND r.risk_id = ? AND r.state = 'open' AND r.expires_at > ?`;
const SELECT_OPEN = `SELECT ${COLUMNS} FROM requests r
  WHERE ${OPEN_OF_RISK} ORDER BY r.created_at LIMIT 1`;
const SELECT_OPEN_BY_CALL = `SELECT ${COLUMNS} FROM requests r
  WHERE ${OPEN_OF_RISK} AND r.tool = ? AND r.fingerprint = ? ORDER BY r.created_at LIMIT 1`;

/**
 * Synchronous lookup of a still-open request, meant to run inside an already-open
 * write transaction: a replayed refusal reuses the request already in the creator's
 * inbox instead of dropping a new one on every retry.
 */
export function findOpenRequestSync(
  ctx: RepoContext,
  missionId: string,
  lookup: OpenRequestLookup,
  now: Iso,
): RequestRecord | null {
  if (lookup.kind !== 'approval') {
    const row = ctx.db
      .prepare<[string, string, string, string], RequestRow>(SELECT_OPEN)
      .get(missionId, lookup.kind, lookup.riskId, now);
    return row ? toRecord(row) : null;
  }
  if (!lookup.tool || !lookup.fingerprint) {
    throw new InvariantError('an approval request is looked up by its tool and fingerprint');
  }
  const row = ctx.db
    .prepare<[string, string, string, string, string, string], RequestRow>(SELECT_OPEN_BY_CALL)
    .get(missionId, lookup.kind, lookup.riskId, now, lookup.tool, lookup.fingerprint);
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
    >(INSERT_OPEN)
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
  return requireRow(getRequestRecord(ctx, id) ?? undefined, 'request', id);
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
  const blobOf = db.prepare<
    [string],
    { args_blob: Buffer | null; key_version: number | null; state: string; expires_at: string }
  >('SELECT args_blob, key_version, state, expires_at FROM requests WHERE id = ?');
  const decideOpen = db.prepare<[string, string, string, string | null, string]>(
    `UPDATE requests SET state = ?, decided_at = ?, decided_by_user_id = ?, decision_json = ?,
       args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  const overdue = db.prepare<[string], RequestRow>(
    `SELECT ${COLUMNS} FROM requests r WHERE r.state = 'open' AND r.expires_at <= ? ORDER BY r.created_at`,
  );
  const expireOne = db.prepare<[string]>(
    `UPDATE requests SET state = 'expired', args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  // Sessions, counters and events belong to the sessions repository: its primitives run
  // here, inside this repository's transactions.
  const sessions = createSessionPrimitives(ctx);
  const extendMission = db.prepare<[string, string, string]>(
    `UPDATE missions SET expires_at = ?, updated_at = ?,
       status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
       closed_at = CASE WHEN status = 'expired' THEN NULL ELSE closed_at END
     WHERE id = ?`,
  );

  const missionFacts = db.prepare<[string], { status: string; expires_at: string | null }>(
    'SELECT status, expires_at FROM missions WHERE id = ?',
  );

  /** The mission of a request as the store holds it now. In-transaction. */
  function missionFactsSync(missionId: string): StoredMissionFacts {
    const row = requireRow(missionFacts.get(missionId), 'mission', missionId);
    return {
      status: parseEnum(STORED_MISSION_STATUSES, row.status, 'missions.status'),
      expiresAt: row.expires_at,
    };
  }

  /** Flips one overdue request and leaves its trace on the session. In-transaction. */
  function expireSync(request: RequestRecord, now: Iso): RequestRecord {
    expireOne.run(request.id);
    const session = sessions.sessionOfMission(request.missionId);
    if (session) {
      sessions.recordEvent(
        session.id,
        {
          kind: 'request',
          riskId: request.riskId,
          details: { request_id: request.id, request_kind: request.kind, state: 'expired' },
        } satisfies NewEvent,
        now,
      );
    }
    return requireRow(getRequestRecord(ctx, request.id) ?? undefined, 'request', request.id);
  }

  function claimContext(
    request: RequestRecord,
    session: SessionRecord | null,
    now: Iso,
  ): ClaimDecisionContext {
    const read = (periodStart: Iso): Map<RiskId, number> =>
      new Map(
        session
          ? sessions.countersOfPeriod(session.id, periodStart).map((c) => [c.riskId, c.consumed])
          : [],
      );
    return {
      request,
      mission: missionFactsSync(request.missionId),
      session,
      now,
      counters: read,
      resetCounters(periodStart) {
        const before = read(periodStart);
        if (session) sessions.resetPeriod(session.id, periodStart);
        return before;
      },
      creditCounter(periodStart, riskId, amount) {
        if (!session || !Number.isInteger(amount) || amount < 1) return false;
        return sessions.creditCounter(session.id, periodStart, riskId, amount);
      },
      setMissionExpiry(expiresAt) {
        extendMission.run(expiresAt, now, request.missionId);
      },
      recordEvent(event) {
        return session ? sessions.recordEvent(session.id, event, now) : null;
      },
    };
  }

  function approvalContext(
    request: RequestRecord,
    session: SessionRecord | null,
    now: Iso,
  ): ApprovalDecisionContext {
    const { tool, fingerprint } = request;
    if (!tool || !fingerprint) {
      throw new InvariantError(`approval request ${request.id} has no tool or fingerprint`);
    }
    return {
      request,
      mission: missionFactsSync(request.missionId),
      session,
      now,
      createApproval(expiresAt) {
        return insertApprovalSync(
          ctx,
          {
            missionId: request.missionId,
            requestId: request.id,
            riskId: request.riskId,
            tool,
            fingerprint,
            expiresAt,
          },
          now,
        );
      },
      riskEvents(query) {
        return session ? sessions.riskEvents(session.id, query) : [];
      },
      recordEvent(event) {
        return session ? sessions.recordEvent(session.id, event, now) : null;
      },
    };
  }

  /**
   * The shared frame of a creator's decision: the request must be of `kind`, still open
   * and unexpired (an overdue one is expired here); `apply` runs, then the conditional
   * update stores the decision and erases the sealed arguments. One transaction.
   */
  function decideOpenSync<R extends RequestDecisionOutcome>(
    id: string,
    kind: RequestKind,
    decidedByUserId: string,
    now: Iso,
    apply: (request: RequestRecord, session: SessionRecord | null) => R,
  ): RequestDecisionResult<R> {
    const request = getRequestRecord(ctx, id);
    if (!request) throw new NotFoundError('request', id);
    if (request.kind !== kind) {
      throw new InvariantError(`request ${id} is not of kind '${kind}' (kind '${request.kind}')`);
    }
    if (request.state !== 'open') return { status: 'not-open', request };
    if (request.expiresAt <= now) return { status: 'not-open', request: expireSync(request, now) };
    const outcome = apply(request, sessions.sessionOfMission(request.missionId));
    decideOpen.run(outcome.state, now, decidedByUserId, toJson(outcome.decision), id);
    return {
      status: 'decided',
      request: requireRow(getRequestRecord(ctx, id) ?? undefined, 'request', id),
      outcome,
    };
  }

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
      const row = requireRow(blobOf.get(id), 'request', id);
      // Held for the lifetime of the request (spec §3.5): an overdue request the
      // sweeper has not reached yet is not opened either.
      if (row.state !== 'open' || row.expires_at <= nowIso(ctx)) return null;
      const text = await openSealedColumn(
        ctx.encryptor,
        requestAd(id),
        row.args_blob,
        row.key_version,
      );
      return text === null ? null : (JSON.parse(text) as unknown);
    },
    async decideClaim(id, decidedByUserId, apply) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () =>
        decideOpenSync(id, 'claim', decidedByUserId, now, (request, session) =>
          apply(claimContext(request, session, now)),
        ),
      );
    },
    async decideApproval(id, decidedByUserId, apply) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () =>
        decideOpenSync(id, 'approval', decidedByUserId, now, (request, session) =>
          apply(approvalContext(request, session, now)),
        ),
      );
    },
    async sweepExpired() {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () =>
        overdue
          .all(now)
          .map(toRecord)
          .map((request) => expireSync(request, now)),
      );
    },
  };
}
