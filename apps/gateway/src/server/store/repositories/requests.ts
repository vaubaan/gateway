import { createPermissionRequests, type PermissionRequestsRepo } from './permission-requests.ts';
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
  RequestLine,
  RequestRecord,
  RiskId,
  SessionRecord,
} from '../types.ts';
import { insertApprovalSync, riskIdsColumn, riskIdsOf } from './approvals.ts';
import {
  nowIso,
  parseEnum,
  parseJsonObject,
  requireRow,
  toJson,
  type RepoContext,
} from './context.ts';
import { REQUEST_KINDS, REQUEST_STATES, STORED_MISSION_STATUSES } from './enums.ts';
import { policyLineKey, type PolicyLineKey } from '@vaubaan/shared';

import { createSessionPrimitives, type EventScope, type RiskEventQuery } from './sessions.ts';
import { missionScopePiece } from './audit.ts';

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
  /** The claimed risk; for an approval request, the first of `riskIds` when given. */
  readonly riskId: RiskId;
  /**
   * Approval requests: every gated risk of the call (spec §3.5 "one request covers the
   * call"). Absent: the one risk of `riskId`. Refused for a claim, which is about one risk.
   */
  readonly riskIds?: readonly RiskId[];
  /**
   * The (set, risk) lines of the request (risk model §4.7): a claim, its one line; an
   * approval request, each gated line of the sets the call was judged against; a
   * permission request, the missing ones. Every risk of the lines is one of `riskIds`
   * (or `riskId`). Absent: each risk in every set of the mission that accepts it.
   */
  readonly lines?: readonly RequestLine[];
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
  /** Consumed count per line in the period starting at `periodStart`. */
  counters(periodStart: Iso): ReadonlyMap<PolicyLineKey, number>;
  /**
   * Sets the counter of ONE line to zero in the period; returns what it held (0
   * when there was nothing to give back, or no session). No other line is touched.
   */
  resetCounter(periodStart: Iso, line: RequestLine): number;
  /** Gives `amount` actions back on one line; false (nothing written) when fewer were consumed. */
  creditCounter(periodStart: Iso, line: RequestLine, amount: number): boolean;
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
   * The approval a grant produces: bound to the request's mission, tool and fingerprint,
   * covering every risk the request lists, single-use, valid until `expiresAt`.
   */
  createApproval(expiresAt: Iso): ApprovalRecord;
  /** Events of the mission's session about some risks (empty when there is no session). */
  riskEvents(query: RiskEventQuery): EventRecord[];
  /** Records an event on the mission's session; null when there is no session. */
  recordEvent(event: NewEvent): EventRecord | null;
}

/**
 * A request's held arguments are read with its mission: never by the request id alone
 * (security audit 2026-10-31, L8). A request of another mission reads as missing.
 */
export interface RequestKey {
  readonly missionId: string;
  readonly requestId: string;
}

export interface RequestsRepo extends PermissionRequestsRepo {
  create(input: CreateRequestInput): Promise<RequestRecord>;
  /** Seals arguments for a request that a decision transaction will drop. */
  prepareArguments(args: unknown): Promise<PreparedArguments>;
  getById(id: string): Promise<RequestRecord | null>;
  /** Open requests addressed to the creator of their mission (the inbox). */
  listOpenForCreator(userId: string): Promise<RequestRecord[]>;
  listForMission(missionId: string): Promise<RequestRecord[]>;
  /**
   * How many requests still wait for an answer (open and not past their expiry at
   * `now`) per mission of a Timeline scope, for Activity's Overview. A mission with
   * none has no entry.
   */
  countOpenInScope(scope: EventScope, now: Iso): Promise<Map<string, number>>;
  /**
   * Decrypts the held arguments for the creator's page. Null once erased, and null for
   * a request that is no longer open — decided, or past its expiry even when the
   * sweeper has not erased the blob yet.
   */
  getArguments(key: RequestKey): Promise<unknown>;
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
  decidePermission<R extends RequestDecisionOutcome>(
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
  risk_ids_json: string | null;
  tool: string | null;
  fingerprint: string | null;
  has_args: number;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
  decision_json: string | null;
}

const COLUMNS = `r.id, r.mission_id, r.session_id, r.kind, r.state, r.risk_id, r.risk_ids_json,
  r.tool, r.fingerprint,
  CASE WHEN r.args_blob IS NULL THEN 0 ELSE 1 END AS has_args, r.created_at, r.expires_at,
  r.decided_at, r.decided_by_user_id, r.decision_json`;

/**
 * The (set, risk) lines of a request, from its `request_lines` rows (migration 0029). A
 * request written before 0029 has one row, for its first risk: the other risks it lists
 * are read in the same set, which was its account's only one. Rows in several sets
 * are read as they are.
 */
export function requestLinesOf(
  riskIds: readonly RiskId[],
  rows: readonly RequestLine[],
): RequestLine[] {
  const sets = [...new Set(rows.map((row) => row.resourceSetId))];
  const [only] = sets;
  if (sets.length !== 1 || only === undefined) return [...rows];
  const held = new Set(rows.map((row) => row.riskId));
  return [
    ...rows,
    ...riskIds.filter((r) => !held.has(r)).map((riskId) => ({ resourceSetId: only, riskId })),
  ];
}

/** The `request_lines` rows of one request. */
export function storedLinesOf(ctx: RepoContext, requestId: string): RequestLine[] {
  return ctx.db
    .prepare<[string], { resource_set_id: string; risk_id: string }>(
      `SELECT resource_set_id, risk_id FROM request_lines
       WHERE request_id = ? ORDER BY resource_set_id, risk_id`,
    )
    .all(requestId)
    .map((l) => ({ resourceSetId: l.resource_set_id, riskId: l.risk_id }));
}

/** The distinct lines as a JSON key: what makes two asks the same. */
export function setRisksJsonOf(lines: readonly RequestLine[]): string {
  const seen = new Set<PolicyLineKey>();
  const pairs: [string, string][] = [];
  for (const line of lines) {
    const key = policyLineKey(line.resourceSetId, line.riskId);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([line.resourceSetId, line.riskId]);
  }
  return JSON.stringify(pairs);
}

function toRecord(ctx: RepoContext, row: RequestRow): RequestRecord {
  const riskIds = riskIdsOf(row.risk_id, row.risk_ids_json);
  return {
    id: row.id,
    missionId: row.mission_id,
    sessionId: row.session_id,
    kind: parseEnum(REQUEST_KINDS, row.kind, 'requests.kind'),
    state: parseEnum(REQUEST_STATES, row.state, 'requests.state'),
    riskId: row.risk_id,
    riskIds,
    lines: requestLinesOf(riskIds, storedLinesOf(ctx, row.id)),
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

const SELECT_BY_ID = `SELECT ${COLUMNS} FROM requests r WHERE r.id = ?`;
const INSERT_OPEN = `INSERT INTO requests (id, mission_id, session_id, kind, state, risk_id, risk_ids_json,
    tool, fingerprint, args_blob, key_version, created_at, expires_at)
  VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`;

function getRequestRecord(ctx: RepoContext, id: string): RequestRecord | null {
  const row = ctx.db.prepare<[string], RequestRow>(SELECT_BY_ID).get(id);
  return row ? toRecord(ctx, row) : null;
}

/**
 * Which open request a refusal may reuse. A claim is keyed by its line (set and risk).
 * An approval request is keyed by the call — its tool and the fingerprint of its
 * arguments — and must cover every gated line the call needs approved (`lines`): an
 * open request that lists fewer is not reused, since granting it would not let the call
 * through.
 */
export type OpenRequestLookup =
  | { readonly kind: 'claim'; readonly line: RequestLine }
  /** A claim on a risk alone, whatever its set: a caller of one set per account. */
  | { readonly kind: 'claim'; readonly riskId: RiskId }
  | ({
      readonly kind: 'approval';
      readonly tool: string;
      readonly fingerprint: string;
    } & (
      | { readonly lines: readonly RequestLine[] }
      /** The gated risks alone, whatever their sets. */
      | { readonly riskIds: readonly RiskId[] }
    ));

const OPEN = `r.mission_id = ? AND r.kind = ? AND r.state = 'open' AND r.expires_at > ?`;
const SELECT_OPEN_CLAIM = `SELECT ${COLUMNS} FROM requests r
  WHERE ${OPEN} AND r.risk_id = ?
    AND EXISTS (SELECT 1 FROM request_lines l
                WHERE l.request_id = r.id AND l.resource_set_id = ? AND l.risk_id = r.risk_id)
  ORDER BY r.created_at LIMIT 1`;
const SELECT_OPEN_CLAIM_OF_RISK = `SELECT ${COLUMNS} FROM requests r
  WHERE ${OPEN} AND r.risk_id = ? ORDER BY r.created_at LIMIT 1`;
const SELECT_OPEN_FOR_CALL = `SELECT ${COLUMNS} FROM requests r
  WHERE ${OPEN} AND r.tool = ? AND r.fingerprint = ? ORDER BY r.created_at, r.id`;

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
  if (lookup.kind === 'claim') {
    const row =
      'line' in lookup
        ? ctx.db
            .prepare<[string, string, string, string, string], RequestRow>(SELECT_OPEN_CLAIM)
            .get(missionId, lookup.kind, now, lookup.line.riskId, lookup.line.resourceSetId)
        : ctx.db
            .prepare<[string, string, string, string], RequestRow>(SELECT_OPEN_CLAIM_OF_RISK)
            .get(missionId, lookup.kind, now, lookup.riskId);
    return row ? toRecord(ctx, row) : null;
  }
  if (!lookup.tool || !lookup.fingerprint) {
    throw new InvariantError('an approval request is looked up by its tool and fingerprint');
  }
  const asked = 'lines' in lookup ? lookup.lines : lookup.riskIds;
  if (asked.length === 0) {
    throw new InvariantError('an approval request is looked up for the gated lines of a call');
  }
  // The oldest open request of this call that covers every line (or risk) asked for.
  const open = ctx.db
    .prepare<[string, string, string, string, string], RequestRow>(SELECT_OPEN_FOR_CALL)
    .all(missionId, lookup.kind, now, lookup.tool, lookup.fingerprint)
    .map((row) => toRecord(ctx, row));
  const covering =
    'lines' in lookup
      ? open.find((request) => {
          const held = new Set(request.lines.map((l) => policyLineKey(l.resourceSetId, l.riskId)));
          return lookup.lines.every((l) => held.has(policyLineKey(l.resourceSetId, l.riskId)));
        })
      : open.find((request) => lookup.riskIds.every((riskId) => request.riskIds.includes(riskId)));
  return covering ?? null;
}

/** Synchronous insert, meant to run inside an already-open write transaction. */
export function insertRequestSync(
  ctx: RepoContext,
  input: InsertRequestInput,
  now: Iso,
): RequestRecord {
  if (input.kind !== 'claim' && (!input.tool || !input.fingerprint)) {
    throw new InvariantError('an approval request carries a tool and a fingerprint');
  }
  if (input.kind === 'claim' && input.riskIds !== undefined) {
    throw new InvariantError('a claim is about one risk');
  }
  // An approval request lists its risks; a claim stores none (its risk is `risk_id`).
  const risks = input.kind !== 'claim' ? riskIdsColumn(input.riskIds ?? [input.riskId]) : null;
  if (risks !== null && risks.riskId !== input.riskId) {
    throw new InvariantError('the risk of an approval request is the first of its risks');
  }
  const listed = new Set(input.riskIds ?? [input.riskId]);
  const lines =
    input.lines ??
    [...listed].flatMap((riskId) =>
      ctx.db
        .prepare<[string, string], { resource_set_id: string }>(
          `SELECT p.resource_set_id FROM mission_policy p
             JOIN mission_resource_sets s ON s.id = p.resource_set_id
           WHERE p.mission_id = ? AND p.risk_id = ? ORDER BY s.account_id, s.position`,
        )
        .all(input.missionId, riskId)
        .map((row) => ({ resourceSetId: row.resource_set_id, riskId })),
    );
  if (input.kind === 'claim' && lines.length > 1) {
    throw new InvariantError('a claim is about one line: its risk in one set');
  }
  if (lines.some((line) => !listed.has(line.riskId))) {
    throw new InvariantError('a line of a request names a risk the request does not list');
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
      risks?.json ?? null,
      input.tool ?? null,
      input.fingerprint ?? null,
      input.prepared?.blob ?? null,
      input.prepared?.keyVersion ?? null,
      now,
      input.expiresAt,
    );
  const insertLine = ctx.db.prepare<[string, string, string]>(
    `INSERT INTO request_lines (request_id, resource_set_id, risk_id) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  for (const line of lines) insertLine.run(id, line.resourceSetId, line.riskId);
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
    [string, string],
    { args_blob: Buffer | null; key_version: number | null; state: string; expires_at: string }
  >(
    'SELECT args_blob, key_version, state, expires_at FROM requests WHERE mission_id = ? AND id = ?',
  );
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
          resourceSetId: request.lines[0]?.resourceSetId ?? null,
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
    const read = (periodStart: Iso): Map<PolicyLineKey, number> =>
      new Map(
        session
          ? sessions
              .countersOfPeriod(session.id, periodStart)
              .map((c) => [policyLineKey(c.resourceSetId, c.riskId), c.consumed])
          : [],
      );
    return {
      request,
      mission: missionFactsSync(request.missionId),
      session,
      now,
      counters: read,
      resetCounter(periodStart, line) {
        if (!session) return 0;
        const held = read(periodStart).get(policyLineKey(line.resourceSetId, line.riskId)) ?? 0;
        // The same conditional write as a quota credit: it gives back exactly what was
        // read, or nothing — both happen inside this transaction.
        if (held < 1 || !sessions.creditCounter(session.id, periodStart, line, held)) return 0;
        return held;
      },
      creditCounter(periodStart, line, amount) {
        if (!session || !Number.isInteger(amount) || amount < 1) return false;
        return sessions.creditCounter(session.id, periodStart, line, amount);
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
            riskIds: request.riskIds,
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
    ...createPermissionRequests(ctx),
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
      return openForCreator.all(userId).map((row) => toRecord(ctx, row));
    },
    async listForMission(missionId) {
      return forMission.all(missionId).map((row) => toRecord(ctx, row));
    },
    async countOpenInScope(scope, now) {
      const scoped = missionScopePiece('mission_id', scope);
      const rows = db
        .prepare<string[], { mission_id: string; n: number }>(
          `SELECT mission_id, COUNT(*) AS n FROM requests
           WHERE state = 'open' AND expires_at > ? AND ${scoped.sql}
           GROUP BY mission_id`,
        )
        .all(now, ...scoped.params);
      return new Map(rows.map((r) => [r.mission_id, r.n]));
    },
    async getArguments({ missionId, requestId: id }) {
      const row = requireRow(blobOf.get(missionId, id), 'request', id);
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
    async decidePermission(id, decidedByUserId, apply) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () =>
        decideOpenSync(id, 'permission', decidedByUserId, now, (request, session) =>
          apply(approvalContext(request, session, now)),
        ),
      );
    },
    async sweepExpired() {
      db.prepare(
        'DELETE FROM permission_refusals WHERE expires_at <= ? AND request_id IS NULL',
      ).run(nowIso(ctx));
      db.prepare(
        'DELETE FROM permission_refusal_lines WHERE refusal_id NOT IN (SELECT id FROM permission_refusals)',
      ).run();
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () =>
        overdue
          .all(now)
          .map((row) => toRecord(ctx, row))
          .map((request) => expireSync(request, now)),
      );
    },
  };
}
