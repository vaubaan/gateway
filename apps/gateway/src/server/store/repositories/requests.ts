import { withImmediateTransaction } from '../db.ts';
import { openSealedColumn, sealText, type Encryptor } from '../encryptor.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type {
  EventRecord,
  Iso,
  NewEvent,
  RequestKind,
  RequestRecord,
  RequestState,
  RiskId,
  SessionRecord,
} from '../types.ts';
import { nowIso, parseJsonObject, requireRow, toJson, type RepoContext } from './context.ts';

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
 * What the `apply` callback of `decideClaim` sees and may do, all inside the open
 * transaction. The rules (which resolution, which amount, which date) belong to the
 * `RequestService`; this context only makes their effects atomic with the decision.
 */
export interface ClaimDecisionContext {
  /** The claim, still `open` and unexpired at `now`. */
  readonly request: RequestRecord;
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

export interface ClaimDecisionOutcome {
  readonly state: 'granted' | 'refused';
  /** Persisted in `requests.decision_json` (resolution, amounts, dates). */
  readonly decision: Record<string, unknown>;
}

export type ClaimDecisionResult<R extends ClaimDecisionOutcome> =
  | { readonly status: 'decided'; readonly request: RequestRecord; readonly outcome: R }
  /** Already granted, refused or expired (an overdue open request is expired here). */
  | { readonly status: 'not-open'; readonly request: RequestRecord };

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
  /** Sweeper: flips open requests past their expiry to `expired` and erases blobs. */
  expireOpen(): Promise<number>;
  /**
   * Same flip as `expireOpen`, returning the expired requests and recording one
   * `request` event (`state: 'expired'`) per request on its mission's session.
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
  /** Approval requests are keyed by fingerprint too; claims ignore it. */
  readonly fingerprint?: string | null;
}

const SELECT_OPEN = `SELECT ${COLUMNS} FROM requests r
  WHERE r.mission_id = ? AND r.kind = ? AND r.risk_id = ? AND r.state = 'open' AND r.expires_at > ?
    AND (? IS NULL OR r.fingerprint = ?)
  ORDER BY r.created_at LIMIT 1`;

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
  const fingerprint = lookup.kind === 'approval' ? (lookup.fingerprint ?? null) : null;
  const row = ctx.db
    .prepare<
      [string, string, string, string, string | null, string | null],
      RequestRow
    >(SELECT_OPEN)
    .get(missionId, lookup.kind, lookup.riskId, now, fingerprint, fingerprint);
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
  const blobOf = db.prepare<[string], { args_blob: Buffer | null; key_version: number | null }>(
    'SELECT args_blob, key_version FROM requests WHERE id = ?',
  );
  const decideOpen = db.prepare<[string, string, string, string | null, string]>(
    `UPDATE requests SET state = ?, decided_at = ?, decided_by_user_id = ?, decision_json = ?,
       args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  const expire = db.prepare<[string]>(
    `UPDATE requests SET state = 'expired', args_blob = NULL, key_version = NULL
     WHERE state = 'open' AND expires_at <= ?`,
  );

  const overdue = db.prepare<[string], RequestRow>(
    `SELECT ${COLUMNS} FROM requests r WHERE r.state = 'open' AND r.expires_at <= ? ORDER BY r.created_at`,
  );
  const expireOne = db.prepare<[string]>(
    `UPDATE requests SET state = 'expired', args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  const sessionOfMission = db.prepare<
    [string],
    { id: string; mission_id: string; created_at: string }
  >('SELECT id, mission_id, created_at FROM sessions WHERE mission_id = ?');
  const countersOfPeriod = db.prepare<[string, string], { risk_id: string; consumed: number }>(
    `SELECT risk_id, consumed FROM session_counters
     WHERE session_id = ? AND period_start = ? ORDER BY risk_id`,
  );
  const zeroPeriod = db.prepare<[string, string]>(
    'UPDATE session_counters SET consumed = 0 WHERE session_id = ? AND period_start = ?',
  );
  const creditOne = db.prepare<[number, string, string, string, number]>(
    `UPDATE session_counters SET consumed = consumed - ?
     WHERE session_id = ? AND period_start = ? AND risk_id = ? AND consumed >= ?`,
  );
  const extendMission = db.prepare<[string, string, string]>(
    `UPDATE missions SET expires_at = ?, updated_at = ?,
       status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
       closed_at = CASE WHEN status = 'expired' THEN NULL ELSE closed_at END
     WHERE id = ?`,
  );
  const insertEvent = db.prepare<
    [string, string, string, string, string | null, string | null, string | null]
  >(
    `INSERT INTO events (id, session_id, ts, kind, risk_id, actor_user_id, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  function sessionOf(missionId: string): SessionRecord | null {
    const row = sessionOfMission.get(missionId);
    return row ? { id: row.id, missionId: row.mission_id, createdAt: row.created_at } : null;
  }

  function recordEventSync(sessionId: string, event: NewEvent, now: Iso): EventRecord {
    const id = ctx.newId();
    const details = event.details ?? null;
    insertEvent.run(
      id,
      sessionId,
      now,
      event.kind,
      event.riskId ?? null,
      event.actorUserId ?? null,
      toJson(details),
    );
    return {
      id,
      sessionId,
      ts: now,
      kind: event.kind,
      riskId: event.riskId ?? null,
      actorUserId: event.actorUserId ?? null,
      details,
    };
  }

  /** Flips one overdue request and leaves its trace on the session. In-transaction. */
  function expireSync(request: RequestRecord, now: Iso): RequestRecord {
    expireOne.run(request.id);
    const session = sessionOf(request.missionId);
    if (session) {
      recordEventSync(
        session.id,
        {
          kind: 'request',
          riskId: request.riskId,
          details: { request_id: request.id, request_kind: request.kind, state: 'expired' },
        },
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
          ? countersOfPeriod.all(session.id, periodStart).map((r) => [r.risk_id, r.consumed])
          : [],
      );
    return {
      request,
      session,
      now,
      counters: read,
      resetCounters(periodStart) {
        const before = read(periodStart);
        if (session) zeroPeriod.run(session.id, periodStart);
        return before;
      },
      creditCounter(periodStart, riskId, amount) {
        if (!session || !Number.isInteger(amount) || amount < 1) return false;
        return creditOne.run(amount, session.id, periodStart, riskId, amount).changes === 1;
      },
      setMissionExpiry(expiresAt) {
        extendMission.run(expiresAt, now, request.missionId);
      },
      recordEvent(event) {
        return session ? recordEventSync(session.id, event, now) : null;
      },
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
      const text = await openSealedColumn(
        ctx.encryptor,
        requestAd(id),
        row.args_blob,
        row.key_version,
      );
      return text === null ? null : (JSON.parse(text) as unknown);
    },
    async decide(id, state, decidedByUserId, decision = null) {
      // One conditional UPDATE decides; the re-read only chooses the error. Atomic on any
      // driver, not just the synchronous one.
      const changed = decideOpen.run(state, nowIso(ctx), decidedByUserId, toJson(decision), id);
      const current = getRequestRecord(ctx, id);
      if (!current) throw new NotFoundError('request', id);
      if (changed.changes === 0) {
        throw new InvariantError(`request ${id} is already ${current.state}`);
      }
      return current;
    },
    async decideClaim(id, decidedByUserId, apply) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const request = getRequestRecord(ctx, id);
        if (!request) throw new NotFoundError('request', id);
        if (request.kind !== 'claim') {
          throw new InvariantError(`request ${id} is not a claim (kind '${request.kind}')`);
        }
        if (request.state !== 'open') return { status: 'not-open' as const, request };
        if (request.expiresAt <= now) {
          return { status: 'not-open' as const, request: expireSync(request, now) };
        }
        const outcome = apply(claimContext(request, sessionOf(request.missionId), now));
        decideOpen.run(outcome.state, now, decidedByUserId, toJson(outcome.decision), id);
        return {
          status: 'decided' as const,
          request: requireRow(getRequestRecord(ctx, id) ?? undefined, 'request', id),
          outcome,
        };
      });
    },
    async expireOpen() {
      return expire.run(nowIso(ctx)).changes;
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
