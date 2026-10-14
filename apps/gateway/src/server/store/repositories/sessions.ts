/**
 * Sessions, durable counters, events — and the transactional decision primitive.
 *
 * Spec §3.3 and §6 ("authoritative, atomic counting"); plan §3.5. The accounting rules
 * (period arithmetic, quota and rate comparisons, gate handling) belong to the budget module
 * and arrive as the `decide` callback. This module guarantees that reading the
 * counters, deciding, consuming an approval, dropping a request, writing the event and
 * decrementing happen in one `BEGIN IMMEDIATE` transaction: two concurrent calls on the
 * last credit yield exactly one allow.
 *
 * An event is stored as given (`UntypedNewEvent`: any kind, any JSON details). The
 * gateway's writers build a typed `NewEvent` and readers go through `parseEventDetails`
 * (`@vaubaan/shared`); this module does not interpret details, with one exception: the
 * `agent_label` column of a call event is a copy of `details.agent_label`, made at
 * insert (`agentLabelColumn`) so the timeline of one label is an indexed read; the
 * `token_kind` / `token_holder` columns are the same kind of copy (`holderColumns`,
 * migration 0010) for the timeline of one token holder. The details stay the source:
 * the columns are never returned in an `EventRecord`.
 *
 * This file is the only writer of `sessions`, `session_counters` and `events`. The
 * requests repository reaches them through `createSessionPrimitives` (a granted claim
 * credits counters and leaves events inside its own transaction). The two files import
 * each other; each only calls the other's functions once the store is being built.
 */

import { isMissionTokenKind, type MissionTokenKind } from '@vaubaan/shared';

import { withImmediateTransaction } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import type {
  ApprovalRecord,
  EventRecord,
  Iso,
  UntypedNewEvent,
  RequestRecord,
  RiskId,
  SessionCounterRecord,
  SessionRecord,
} from '../types.ts';
import { consumeApprovalSync, findApprovalsSync, type ApprovedCall } from './approvals.ts';
import {
  DEFAULT_LIST_LIMIT,
  nowIso,
  parseJsonObject,
  placeholders,
  requireRow,
  toJson,
  type RepoContext,
} from './context.ts';
import {
  findOpenRequestSync,
  insertRequestSync,
  type InsertRequestInput,
  type OpenRequestLookup,
} from './requests.ts';

export interface DecideInput {
  readonly missionId: string;
  /** Risks the call touches; the counters of exactly these are read and, on allow, incremented. */
  readonly riskIds: readonly RiskId[];
  /** Start of the current period, computed by the caller from the mission's anchor and length. */
  readonly periodStart: Iso;
}

/** What the `decide` callback sees and may do, all inside the open transaction. */
export interface DecideContext {
  readonly session: SessionRecord;
  /** Consumed count per requested risk in this period (0 when no row exists yet). */
  readonly counters: ReadonlyMap<RiskId, number>;
  /**
   * The limits of the requested risks as the mission's policy stores them NOW, read in
   * this transaction: a limit changed after the caller loaded the mission is the one
   * that decides (`MissionsRepo.setLimits` writes in a transaction of its own, so a
   * decision sees either the old values or the new ones, never a call above the new
   * limit once it is committed). A risk absent from the policy has no entry.
   */
  readonly limits: ReadonlyMap<RiskId, StoredLimits>;
  readonly now: Iso;
  /**
   * Non-consuming lookup of the usable approvals of the mission for one call (tool and
   * argument fingerprint), soonest-expiring first; each lists the gated risks it covers.
   */
  findApprovals(call: ApprovedCall): ApprovalRecord[];
  /** Single-use consumption of one approval of the mission; `null` when it is not usable. */
  consumeApproval(approvalId: string): ApprovalRecord | null;
  /**
   * Events of this session about some risks, oldest first — how the decision learns
   * that the creator opened a gate for the period (spec §3.5). Details are returned as
   * stored; the caller reads them through `parseEventDetails`.
   */
  riskEvents(query: RiskEventQuery): EventRecord[];
  /** A request of the mission still open in the creator's inbox, to reuse on a replay. */
  findOpenRequest(lookup: OpenRequestLookup): RequestRecord | null;
  /**
   * Drops a claim or approval request into the creator's inbox (refusal path). Approval
   * arguments must be sealed beforehand with `RequestsRepo.prepareArguments` (the
   * encryptor is asynchronous, this transaction is not) and passed as `prepared`.
   */
  createRequest(input: Omit<InsertRequestInput, 'missionId' | 'sessionId'>): RequestRecord;
  /** Records an extra event beyond the one returned in the outcome. */
  recordEvent(event: UntypedNewEvent): EventRecord;
}

/** The limits of one accepted risk as `mission_policy` holds them. */
export interface StoredLimits {
  readonly quota: number;
  readonly rateLimit: number;
  readonly rateWindowSeconds: number;
}

/** Which events of a session `riskEvents` returns. */
export interface RiskEventQuery {
  readonly kinds: readonly string[];
  /** The `risk_id` column of the events. */
  readonly riskIds: readonly RiskId[];
  /** `ts >= since`. */
  readonly since: Iso;
}

export interface DecisionOutcome {
  /** True increments every requested counter by one; false leaves them untouched. */
  readonly allow: boolean;
  /** Event written in the same transaction (e.g. `call-allowed`, `call-refused`). */
  readonly event?: UntypedNewEvent | null;
}

export interface DecideResult<R extends DecisionOutcome> {
  readonly outcome: R;
  readonly session: SessionRecord;
  /** Counters after the transaction, for the requested risks. */
  readonly counters: ReadonlyMap<RiskId, number>;
}

export interface SessionsRepo {
  getByMission(missionId: string): Promise<SessionRecord | null>;
  /** "The session is born on the first call": idempotent creation. */
  getOrCreate(missionId: string): Promise<SessionRecord>;
  /**
   * Runs `decide` inside one `BEGIN IMMEDIATE` transaction with the current counters and,
   * when it allows, increments the counters of every requested risk by one. The callback
   * must be synchronous and side-effect free apart from the `DecideContext` methods.
   */
  decideAndDecrement<R extends DecisionOutcome>(
    input: DecideInput,
    decide: (ctx: DecideContext) => R,
  ): Promise<DecideResult<R>>;
  counters(sessionId: string, periodStart?: Iso): Promise<SessionCounterRecord[]>;
  recordEvent(sessionId: string, event: UntypedNewEvent): Promise<EventRecord>;
  listEvents(sessionId: string, options?: ListEventsOptions): Promise<EventRecord[]>;
  /**
   * The session timeline, newest first (`ts DESC, id DESC`), paged by keyset: `before`
   * is the last event of the previous page. `listEvents` with `order: 'desc'` gives the
   * same first page; this one resumes after a position.
   */
  listRecentEvents(sessionId: string, options: RecentEventsOptions): Promise<EventRecord[]>;
  /**
   * The sessions that hold an event or a counter older than `cutoff`: what a retention
   * sweep looks at. A superset of what it removes.
   */
  withHistoryBefore(cutoff: Iso): Promise<SessionRecord[]>;
  /**
   * Retention of one session's history, in one transaction. The only path that deletes
   * an event or a counter while its mission exists; the caller computes the bounds from
   * the mission's period (`budget/retention.ts`).
   */
  purgeHistory(sessionId: string, bounds: HistoryPurgeBounds): Promise<HistoryPurged>;
}

export interface HistoryPurgeBounds {
  /** Events with `ts < eventsBefore` go… */
  readonly eventsBefore: Iso;
  /** …except those of these kinds written at or after `since`, whatever their age. */
  readonly keep: { readonly kinds: readonly string[]; readonly since: Iso };
  /** Counters with `period_start < countersBefore` go; `null` removes none. */
  readonly countersBefore: Iso | null;
}

export interface HistoryPurged {
  readonly events: number;
  readonly counters: number;
}

export interface RecentEventsOptions {
  readonly before?: { readonly ts: Iso; readonly id: string };
  readonly limit: number;
  /**
   * Only the call events (`CALL_EVENT_KINDS`) that carried this agent label (`null`:
   * the calls that carried none), or only those made with a token of this holder.
   * Same order and keyset as the unfiltered timeline.
   */
  readonly calls?: { readonly agentLabel: string | null } | { readonly holder: EventHolder };
}

/** A token holder as the events keep it: the kind, and the user id or the token name. */
export interface EventHolder {
  readonly kind: MissionTokenKind;
  readonly holder: string;
}

/** The event kinds that carry an agent label (`CallEventDetails`, `@vaubaan/shared`). */
export const CALL_EVENT_KINDS = ['call-allowed', 'call-refused'] as const;

/**
 * The `agent_label` column of an event about to be stored: the non-empty string its
 * writer put in `details.agent_label`, on a call event; `null` otherwise. Migration
 * 0008 backfills older rows with the same rule.
 */
export function agentLabelColumn(event: UntypedNewEvent): string | null {
  if (!(CALL_EVENT_KINDS as readonly string[]).includes(event.kind)) return null;
  const details: { readonly agent_label?: unknown } = event.details ?? {};
  const label = details.agent_label;
  return typeof label === 'string' && label !== '' ? label : null;
}

/**
 * The `token_kind` / `token_holder` columns of an event about to be stored: what its
 * writer put in `details.token_kind` and `details.holder`, on a call event; `null`
 * otherwise (and for a call written before tokens had a holder).
 */
export function holderColumns(event: UntypedNewEvent): EventHolder | null {
  if (!(CALL_EVENT_KINDS as readonly string[]).includes(event.kind)) return null;
  const details: { readonly token_kind?: unknown; readonly holder?: unknown } = event.details ?? {};
  const { token_kind: kind, holder } = details;
  if (!isMissionTokenKind(kind) || typeof holder !== 'string' || holder === '') return null;
  return { kind, holder };
}

export interface ListEventsOptions {
  readonly since?: Iso;
  readonly limit?: number;
  /** Only these event kinds. */
  readonly kinds?: readonly string[];
  /** `desc` returns the most recent events first (the tail of the timeline). Default `asc`. */
  readonly order?: 'asc' | 'desc';
}

interface SessionRow {
  id: string;
  mission_id: string;
  created_at: string;
}

interface CounterRow {
  session_id: string;
  risk_id: string;
  period_start: string;
  consumed: number;
}

interface LimitsRow {
  risk_id: string;
  quota: number;
  rate_limit: number;
  rate_window_seconds: number;
}

interface EventRow {
  id: string;
  session_id: string;
  ts: string;
  kind: string;
  risk_id: string | null;
  actor_user_id: string | null;
  details_json: string | null;
}

const SESSION_COLUMNS = 'id, mission_id, created_at';
const COUNTER_COLUMNS = 'session_id, risk_id, period_start, consumed';
const EVENT_COLUMNS = 'id, session_id, ts, kind, risk_id, actor_user_id, details_json';
/** `kind IN (…)` over the call kinds: constants of this file, never input. */
const CALL_KINDS_SQL = CALL_EVENT_KINDS.map((kind) => `'${kind}'`).join(', ');

function sessionToRecord(row: SessionRow): SessionRecord {
  return { id: row.id, missionId: row.mission_id, createdAt: row.created_at };
}

function counterToRecord(row: CounterRow): SessionCounterRecord {
  return {
    sessionId: row.session_id,
    riskId: row.risk_id,
    periodStart: row.period_start,
    consumed: row.consumed,
  };
}

function eventToRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ts: row.ts,
    kind: row.kind,
    riskId: row.risk_id,
    actorUserId: row.actor_user_id,
    details: parseJsonObject(row.details_json, 'events.details_json'),
  };
}

/**
 * The session-side reads and writes that also run inside another repository's
 * transaction (a claim decision, the request sweeper). All synchronous and without a
 * transaction of their own: the caller holds it, so each stays atomic with the rest of
 * the caller's work.
 */
export interface SessionPrimitives {
  sessionOfMission(missionId: string): SessionRecord | null;
  /** Appends one event at `now` and returns the stored row. */
  recordEvent(sessionId: string, event: UntypedNewEvent, now: Iso): EventRecord;
  /** Every counter of the session in the period starting at `periodStart`, by risk id. */
  countersOfPeriod(sessionId: string, periodStart: Iso): SessionCounterRecord[];
  /** Gives `amount` actions back on one risk; false (nothing written) when fewer were consumed. */
  creditCounter(sessionId: string, periodStart: Iso, riskId: RiskId, amount: number): boolean;
  /** Events of the session of some kinds about some risks since an instant, oldest first. */
  riskEvents(sessionId: string, query: RiskEventQuery): EventRecord[];
}

export function createSessionPrimitives(ctx: RepoContext): SessionPrimitives {
  const { db } = ctx;
  const byMission = db.prepare<[string], SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE mission_id = ?`,
  );
  const insertEvent = db.prepare<
    [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO events (${EVENT_COLUMNS}, agent_label, token_kind, token_holder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const eventById = db.prepare<[string], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`,
  );
  const countersOfPeriod = db.prepare<[string, string], CounterRow>(
    `SELECT ${COUNTER_COLUMNS} FROM session_counters
     WHERE session_id = ? AND period_start = ? ORDER BY risk_id`,
  );
  const creditOne = db.prepare<[number, string, string, string, number]>(
    `UPDATE session_counters SET consumed = consumed - ?
     WHERE session_id = ? AND period_start = ? AND risk_id = ? AND consumed >= ?`,
  );

  return {
    sessionOfMission(missionId) {
      const row = byMission.get(missionId);
      return row ? sessionToRecord(row) : null;
    },
    recordEvent(sessionId, event, now) {
      const id = ctx.newId();
      const holder = holderColumns(event);
      insertEvent.run(
        id,
        sessionId,
        now,
        event.kind,
        event.riskId ?? null,
        event.actorUserId ?? null,
        toJson(event.details),
        agentLabelColumn(event),
        holder?.kind ?? null,
        holder?.holder ?? null,
      );
      return eventToRecord(requireRow(eventById.get(id), 'event', id));
    },
    countersOfPeriod(sessionId, periodStart) {
      return countersOfPeriod.all(sessionId, periodStart).map(counterToRecord);
    },
    creditCounter(sessionId, periodStart, riskId, amount) {
      return creditOne.run(amount, sessionId, periodStart, riskId, amount).changes === 1;
    },
    riskEvents(sessionId, query) {
      if (query.kinds.length === 0 || query.riskIds.length === 0) return [];
      return db
        .prepare<string[], EventRow>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE session_id = ? AND ts >= ?
             AND kind IN (${placeholders(query.kinds.length)})
             AND risk_id IN (${placeholders(query.riskIds.length)})
           ORDER BY ts, id`,
        )
        .all(sessionId, query.since, ...query.kinds, ...query.riskIds)
        .map(eventToRecord);
    },
  };
}

export function createSessionsRepo(ctx: RepoContext): SessionsRepo {
  const { db } = ctx;
  const primitives = createSessionPrimitives(ctx);
  const insertSession = db.prepare<[string, string, string]>(
    `INSERT INTO sessions (id, mission_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (mission_id) DO NOTHING`,
  );
  const increment = db.prepare<[string, string, string]>(
    `INSERT INTO session_counters (session_id, risk_id, period_start, consumed) VALUES (?, ?, ?, 1)
     ON CONFLICT (session_id, risk_id, period_start) DO UPDATE SET consumed = session_counters.consumed + 1`,
  );
  const countersAll = db.prepare<[string], CounterRow>(
    `SELECT ${COUNTER_COLUMNS} FROM session_counters
     WHERE session_id = ? ORDER BY period_start, risk_id`,
  );
  const missionExists = db.prepare<[string], { one: number }>(
    'SELECT 1 AS one FROM missions WHERE id = ?',
  );
  const eventsSince = db.prepare<[string, string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE session_id = ? AND ts >= ? ORDER BY ts, id LIMIT ?`,
  );
  const eventsAll = db.prepare<[string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE session_id = ? ORDER BY ts, id LIMIT ?`,
  );
  const eventsRecent = db.prepare<[string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
  );
  const eventsRecentBefore = db.prepare<[string, string, string, string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE session_id = ? AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`,
  );
  // The calls of one label, and the calls without one. Separate statements rather than
  // `? IS NULL OR agent_label = ?`: Postgres cannot type a parameter that is only
  // compared with NULL. The index `events_session_label_ts` serves the four of them.
  const CALLS = `SELECT ${EVENT_COLUMNS} FROM events WHERE session_id = ? AND kind IN (${CALL_KINDS_SQL})`;
  const KEYSET = 'AND (ts < ? OR (ts = ? AND id < ?))';
  const NEWEST_FIRST = 'ORDER BY ts DESC, id DESC LIMIT ?';
  const callsOfLabel = db.prepare<[string, string, number], EventRow>(
    `${CALLS} AND agent_label = ? ${NEWEST_FIRST}`,
  );
  const callsOfLabelBefore = db.prepare<[string, string, string, string, string, number], EventRow>(
    `${CALLS} AND agent_label = ? ${KEYSET} ${NEWEST_FIRST}`,
  );
  const callsUnlabelled = db.prepare<[string, number], EventRow>(
    `${CALLS} AND agent_label IS NULL ${NEWEST_FIRST}`,
  );
  const callsUnlabelledBefore = db.prepare<[string, string, string, string, number], EventRow>(
    `${CALLS} AND agent_label IS NULL ${KEYSET} ${NEWEST_FIRST}`,
  );

  // The calls made with a token of one holder (index `events_session_holder_ts`).
  const callsOfHolder = db.prepare<[string, string, string, number], EventRow>(
    `${CALLS} AND token_kind = ? AND token_holder = ? ${NEWEST_FIRST}`,
  );
  const callsOfHolderBefore = db.prepare<
    [string, string, string, string, string, string, number],
    EventRow
  >(`${CALLS} AND token_kind = ? AND token_holder = ? ${KEYSET} ${NEWEST_FIRST}`);

  function getOrCreateSync(missionId: string, now: Iso): SessionRecord {
    // Checked first: with foreign keys on, the insert would otherwise surface a driver
    // error instead of the store's NotFoundError.
    if (!missionExists.get(missionId)) throw new NotFoundError('mission', missionId);
    insertSession.run(ctx.newId(), missionId, now);
    return requireRow(primitives.sessionOfMission(missionId) ?? undefined, 'session', missionId);
  }

  function readCounters(
    sessionId: string,
    periodStart: Iso,
    riskIds: readonly RiskId[],
  ): Map<RiskId, number> {
    const result = new Map<RiskId, number>(riskIds.map((r) => [r, 0]));
    if (riskIds.length === 0) return result;
    const rows = db
      .prepare<string[], CounterRow>(
        `SELECT ${COUNTER_COLUMNS} FROM session_counters
         WHERE session_id = ? AND period_start = ? AND risk_id IN (${placeholders(riskIds.length)})`,
      )
      .all(sessionId, periodStart, ...riskIds);
    for (const row of rows) result.set(row.risk_id, row.consumed);
    return result;
  }

  function readLimits(missionId: string, riskIds: readonly RiskId[]): Map<RiskId, StoredLimits> {
    const result = new Map<RiskId, StoredLimits>();
    if (riskIds.length === 0) return result;
    // A Postgres port reads these rows `FOR SHARE`, so that a limits update waits for
    // the decision (or the decision for the update) instead of interleaving.
    const rows = db
      .prepare<string[], LimitsRow>(
        `SELECT risk_id, quota, rate_limit, rate_window_seconds FROM mission_policy
         WHERE mission_id = ? AND risk_id IN (${placeholders(riskIds.length)})`,
      )
      .all(missionId, ...riskIds);
    for (const row of rows) {
      result.set(row.risk_id, {
        quota: row.quota,
        rateLimit: row.rate_limit,
        rateWindowSeconds: row.rate_window_seconds,
      });
    }
    return result;
  }

  function recentRows(sessionId: string, options: RecentEventsOptions): EventRow[] {
    const { before, limit, calls } = options;
    if (!calls) {
      return before
        ? eventsRecentBefore.all(sessionId, before.ts, before.ts, before.id, limit)
        : eventsRecent.all(sessionId, limit);
    }
    if ('holder' in calls) {
      const { kind, holder } = calls.holder;
      return before
        ? callsOfHolderBefore.all(sessionId, kind, holder, before.ts, before.ts, before.id, limit)
        : callsOfHolder.all(sessionId, kind, holder, limit);
    }
    const label = calls.agentLabel;
    if (label === null) {
      return before
        ? callsUnlabelledBefore.all(sessionId, before.ts, before.ts, before.id, limit)
        : callsUnlabelled.all(sessionId, limit);
    }
    return before
      ? callsOfLabelBefore.all(sessionId, label, before.ts, before.ts, before.id, limit)
      : callsOfLabel.all(sessionId, label, limit);
  }

  const withHistory = db.prepare<[string, string], SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions
     WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id AND e.ts < ?)
        OR EXISTS (SELECT 1 FROM session_counters c
                   WHERE c.session_id = sessions.id AND c.period_start < ?)
     ORDER BY id`,
  );
  const purgeEventsBefore = db.prepare<[string, string]>(
    'DELETE FROM events WHERE session_id = ? AND ts < ?',
  );
  const purgeCountersBefore = db.prepare<[string, string]>(
    'DELETE FROM session_counters WHERE session_id = ? AND period_start < ?',
  );

  return {
    async getByMission(missionId) {
      return primitives.sessionOfMission(missionId);
    },
    async withHistoryBefore(cutoff) {
      return withHistory.all(cutoff, cutoff).map(sessionToRecord);
    },
    async purgeHistory(sessionId, bounds) {
      const { eventsBefore, keep, countersBefore } = bounds;
      return withImmediateTransaction(db, () => {
        const events =
          keep.kinds.length === 0
            ? purgeEventsBefore.run(sessionId, eventsBefore).changes
            : db
                .prepare<string[]>(
                  `DELETE FROM events
                   WHERE session_id = ? AND ts < ?
                     AND NOT (ts >= ? AND kind IN (${placeholders(keep.kinds.length)}))`,
                )
                .run(sessionId, eventsBefore, keep.since, ...keep.kinds).changes;
        const counters =
          countersBefore === null ? 0 : purgeCountersBefore.run(sessionId, countersBefore).changes;
        return { events, counters };
      });
    },
    async getOrCreate(missionId) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => getOrCreateSync(missionId, now));
    },
    async decideAndDecrement(input, decide) {
      const now = nowIso(ctx);
      const riskIds = [...new Set(input.riskIds)];
      return withImmediateTransaction(db, () => {
        const session = getOrCreateSync(input.missionId, now);
        const counters = readCounters(session.id, input.periodStart, riskIds);
        const context: DecideContext = {
          session,
          counters,
          limits: readLimits(input.missionId, riskIds),
          now,
          findApprovals: (call) => findApprovalsSync(ctx, input.missionId, call, now),
          consumeApproval: (id) => consumeApprovalSync(ctx, input.missionId, id, now),
          riskEvents: (query) => primitives.riskEvents(session.id, query),
          findOpenRequest: (lookup) => findOpenRequestSync(ctx, input.missionId, lookup, now),
          createRequest: (request) =>
            insertRequestSync(
              ctx,
              { ...request, missionId: input.missionId, sessionId: session.id },
              now,
            ),
          recordEvent: (event) => primitives.recordEvent(session.id, event, now),
        };
        const outcome = decide(context);
        if (outcome.allow) {
          for (const riskId of riskIds) increment.run(session.id, riskId, input.periodStart);
        }
        if (outcome.event) primitives.recordEvent(session.id, outcome.event, now);
        return {
          outcome,
          session,
          counters: readCounters(session.id, input.periodStart, riskIds),
        };
      });
    },
    async counters(sessionId, periodStart) {
      return periodStart
        ? primitives.countersOfPeriod(sessionId, periodStart)
        : countersAll.all(sessionId).map(counterToRecord);
    },
    async recordEvent(sessionId, event) {
      return primitives.recordEvent(sessionId, event, nowIso(ctx));
    },
    async listEvents(sessionId, options = {}) {
      const limit = options.limit ?? DEFAULT_LIST_LIMIT;
      if (!options.kinds && options.order !== 'desc') {
        const rows = options.since
          ? eventsSince.all(sessionId, options.since, limit)
          : eventsAll.all(sessionId, limit);
        return rows.map(eventToRecord);
      }
      const kinds = options.kinds ?? [];
      if (options.kinds && kinds.length === 0) return [];
      const direction = options.order === 'desc' ? 'DESC' : 'ASC';
      const where = ['session_id = ?'];
      const params: (string | number)[] = [sessionId];
      if (options.since) {
        where.push('ts >= ?');
        params.push(options.since);
      }
      if (kinds.length > 0) {
        where.push(`kind IN (${placeholders(kinds.length)})`);
        params.push(...kinds);
      }
      params.push(limit);
      return db
        .prepare<(string | number)[], EventRow>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE ${where.join(' AND ')} ORDER BY ts ${direction}, id ${direction} LIMIT ?`,
        )
        .all(...params)
        .map(eventToRecord);
    },
    async listRecentEvents(sessionId, options) {
      return recentRows(sessionId, options).map(eventToRecord);
    },
  };
}
