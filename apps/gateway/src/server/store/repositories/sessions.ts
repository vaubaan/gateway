/**
 * Sessions, durable counters, events — and the transactional decision primitive.
 *
 * Spec §3.3 and §6 ("authoritative, atomic counting"); plan §3.5. The accounting rules
 * (period arithmetic, quota and rate comparisons, gate handling) belong to feature P1.3
 * and arrive as the `decide` callback. This module guarantees that reading the
 * counters, deciding, consuming an approval, dropping a request, writing the event and
 * decrementing happen in one `BEGIN IMMEDIATE` transaction: two concurrent calls on the
 * last credit yield exactly one allow.
 */

import { withImmediateTransaction } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import type {
  ApprovalRecord,
  EventRecord,
  Iso,
  NewEvent,
  RequestRecord,
  RiskId,
  SessionCounterRecord,
  SessionRecord,
} from '../types.ts';
import { consumeApprovalSync } from './approvals.ts';
import { nowIso, parseJson, placeholders, toJson, type RepoContext } from './context.ts';
import { insertRequestSync, type InsertRequestInput } from './requests.ts';

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
  readonly now: Iso;
  /** Single-use approval consumption bound to `(mission, risk, fingerprint)`. */
  consumeApproval(riskId: RiskId, fingerprint: string): ApprovalRecord | null;
  /**
   * Drops a claim or approval request into the creator's inbox (refusal path). Approval
   * arguments must be sealed beforehand with `RequestsRepo.prepareArguments` (the
   * encryptor is asynchronous, this transaction is not) and passed as `prepared`.
   */
  createRequest(input: Omit<InsertRequestInput, 'missionId' | 'sessionId'>): RequestRecord;
  /** Records an extra event beyond the one returned in the outcome. */
  recordEvent(event: NewEvent): EventRecord;
}

export interface DecisionOutcome {
  /** True increments every requested counter by one; false leaves them untouched. */
  readonly allow: boolean;
  /** Event written in the same transaction (e.g. `allowed-call`, `refused-call`). */
  readonly event?: NewEvent | null;
}

export interface DecideResult<R extends DecisionOutcome> {
  readonly outcome: R;
  readonly session: SessionRecord;
  /** Counters after the transaction, for the requested risks. */
  readonly counters: ReadonlyMap<RiskId, number>;
}

export interface SessionsRepo {
  getById(id: string): Promise<SessionRecord | null>;
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
  /** A granted claim "reset": the counters of the period go back to zero. */
  resetCounters(sessionId: string, periodStart: Iso, riskId?: RiskId): Promise<number>;
  recordEvent(sessionId: string, event: NewEvent): Promise<EventRecord>;
  listEvents(sessionId: string, options?: { since?: Iso; limit?: number }): Promise<EventRecord[]>;
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

interface EventRow {
  id: string;
  session_id: string;
  ts: string;
  kind: string;
  risk_id: string | null;
  actor_user_id: string | null;
  details_json: string | null;
}

function sessionToRecord(row: SessionRow): SessionRecord {
  return { id: row.id, missionId: row.mission_id, createdAt: row.created_at };
}

function eventToRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ts: row.ts,
    kind: row.kind,
    riskId: row.risk_id,
    actorUserId: row.actor_user_id,
    details: parseJson<Record<string, unknown>>(row.details_json),
  };
}

export function createSessionsRepo(ctx: RepoContext): SessionsRepo {
  const { db } = ctx;
  const byId = db.prepare<[string], SessionRow>(
    'SELECT id, mission_id, created_at FROM sessions WHERE id = ?',
  );
  const byMission = db.prepare<[string], SessionRow>(
    'SELECT id, mission_id, created_at FROM sessions WHERE mission_id = ?',
  );
  const insertSession = db.prepare<[string, string, string]>(
    `INSERT INTO sessions (id, mission_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (mission_id) DO NOTHING`,
  );
  const increment = db.prepare<[string, string, string]>(
    `INSERT INTO session_counters (session_id, risk_id, period_start, consumed) VALUES (?, ?, ?, 1)
     ON CONFLICT (session_id, risk_id, period_start) DO UPDATE SET consumed = session_counters.consumed + 1`,
  );
  const countersOfPeriod = db.prepare<[string, string], CounterRow>(
    `SELECT session_id, risk_id, period_start, consumed FROM session_counters
     WHERE session_id = ? AND period_start = ? ORDER BY risk_id`,
  );
  const countersAll = db.prepare<[string], CounterRow>(
    `SELECT session_id, risk_id, period_start, consumed FROM session_counters
     WHERE session_id = ? ORDER BY period_start, risk_id`,
  );
  const insertEvent = db.prepare<
    [string, string, string, string, string | null, string | null, string | null]
  >(
    `INSERT INTO events (id, session_id, ts, kind, risk_id, actor_user_id, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const eventById = db.prepare<[string], EventRow>(
    'SELECT id, session_id, ts, kind, risk_id, actor_user_id, details_json FROM events WHERE id = ?',
  );

  function getOrCreateSync(missionId: string, now: Iso): SessionRecord {
    insertSession.run(ctx.newId(), missionId, now);
    const row = byMission.get(missionId);
    if (!row) throw new NotFoundError('mission', missionId);
    return sessionToRecord(row);
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
        `SELECT session_id, risk_id, period_start, consumed FROM session_counters
         WHERE session_id = ? AND period_start = ? AND risk_id IN (${placeholders(riskIds.length)})`,
      )
      .all(sessionId, periodStart, ...riskIds);
    for (const row of rows) result.set(row.risk_id, row.consumed);
    return result;
  }

  function recordEventSync(sessionId: string, event: NewEvent, now: Iso): EventRecord {
    const id = ctx.newId();
    insertEvent.run(
      id,
      sessionId,
      now,
      event.kind,
      event.riskId ?? null,
      event.actorUserId ?? null,
      toJson(event.details),
    );
    const row = eventById.get(id);
    if (!row) throw new NotFoundError('event', id);
    return eventToRecord(row);
  }

  return {
    async getById(id) {
      const row = byId.get(id);
      return row ? sessionToRecord(row) : null;
    },
    async getByMission(missionId) {
      const row = byMission.get(missionId);
      return row ? sessionToRecord(row) : null;
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
          now,
          consumeApproval: (riskId, fingerprint) =>
            consumeApprovalSync(ctx, input.missionId, riskId, fingerprint, now),
          createRequest: (request) =>
            insertRequestSync(
              ctx,
              { ...request, missionId: input.missionId, sessionId: session.id },
              now,
            ),
          recordEvent: (event) => recordEventSync(session.id, event, now),
        };
        const outcome = decide(context);
        if (outcome.allow) {
          for (const riskId of riskIds) increment.run(session.id, riskId, input.periodStart);
        }
        if (outcome.event) recordEventSync(session.id, outcome.event, now);
        return {
          outcome,
          session,
          counters: readCounters(session.id, input.periodStart, riskIds),
        };
      });
    },
    async counters(sessionId, periodStart) {
      const rows = periodStart
        ? countersOfPeriod.all(sessionId, periodStart)
        : countersAll.all(sessionId);
      return rows.map((r) => ({
        sessionId: r.session_id,
        riskId: r.risk_id,
        periodStart: r.period_start,
        consumed: r.consumed,
      }));
    },
    async resetCounters(sessionId, periodStart, riskId) {
      if (riskId) {
        return db
          .prepare<
            [string, string, string]
          >('UPDATE session_counters SET consumed = 0 WHERE session_id = ? AND period_start = ? AND risk_id = ?')
          .run(sessionId, periodStart, riskId).changes;
      }
      return db
        .prepare<
          [string, string]
        >('UPDATE session_counters SET consumed = 0 WHERE session_id = ? AND period_start = ?')
        .run(sessionId, periodStart).changes;
    },
    async recordEvent(sessionId, event) {
      return recordEventSync(sessionId, event, nowIso(ctx));
    },
    async listEvents(sessionId, options = {}) {
      const limit = options.limit ?? 1000;
      const rows = options.since
        ? db
            .prepare<[string, string, number], EventRow>(
              `SELECT id, session_id, ts, kind, risk_id, actor_user_id, details_json FROM events
               WHERE session_id = ? AND ts >= ? ORDER BY ts, id LIMIT ?`,
            )
            .all(sessionId, options.since, limit)
        : db
            .prepare<[string, number], EventRow>(
              `SELECT id, session_id, ts, kind, risk_id, actor_user_id, details_json FROM events
               WHERE session_id = ? ORDER BY ts, id LIMIT ?`,
            )
            .all(sessionId, limit);
      return rows.map(eventToRecord);
    },
  };
}
