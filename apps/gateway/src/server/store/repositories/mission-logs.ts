/**
 * Mission logs, durable counters, events — and the transactional decision primitive.
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
 * This file is the only writer of `mission_logs`, `mission_log_counters` and `events`. The
 * requests repository reaches them through `createMissionLogPrimitives` (a granted claim
 * credits counters and leaves events inside its own transaction). The two files import
 * each other; each only calls the other's functions once the store is being built.
 */

import {
  isMissionTokenKind,
  GATES,
  policyLineKey,
  type Gate,
  type MissionTokenKind,
  type PolicyLineKey,
} from '@vaubaan/shared';

import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type {
  ApprovalRecord,
  EventRecord,
  Iso,
  UntypedNewEvent,
  RequestLine,
  RequestRecord,
  RiskId,
  MissionLogCounterRecord,
  MissionLogRecord,
} from '../types.ts';
import { consumeApprovalSync, findApprovalsSync, type ApprovedCall } from './approvals.ts';
import {
  DEFAULT_LIST_LIMIT,
  nowIso,
  parseJsonObject,
  parseEnum,
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

export type DecideInput = {
  readonly missionId: string;
  /** Start of the current period, computed by the caller from the mission's anchor and length. */
  readonly periodStart: Iso;
} & (
  | {
      /**
       * The lines the call is charged on — each touched risk in each resource set the
       * call was judged against (risk model §4.7); the counters of exactly these are read
       * and, on allow, incremented.
       */
      readonly lines: readonly RequestLine[];
    }
  | {
      /**
       * Risks alone: each in every set of the mission that accepts it (`linesOfRisks`),
       * exact for a mission with one set per account.
       */
      readonly riskIds: readonly RiskId[];
    }
);

/** What the `decide` callback sees and may do, all inside the open transaction. */
export interface DecideContext {
  readonly missionLog: MissionLogRecord;
  /** Consumed count per requested line in this period (0 when no row exists yet). */
  readonly counters: ReadonlyMap<PolicyLineKey, number>;
  /**
   * The limits of the requested risks as the mission's policy stores them NOW, read in
   * this transaction: a limit changed after the caller loaded the mission is the one
   * that decides (`MissionsRepo.setLimits` writes in a transaction of its own, so a
   * decision sees either the old values or the new ones, never a call above the new
   * limit once it is committed). A line absent from the policy has no entry.
   */
  readonly limits: ReadonlyMap<PolicyLineKey, StoredLimits>;
  readonly now: Iso;
  /**
   * Non-consuming lookup of the usable approvals of the mission for one call (tool and
   * argument fingerprint), soonest-expiring first; each lists the gated risks it covers.
   */
  findApprovals(call: ApprovedCall): ApprovalRecord[];
  /** Single-use consumption of one approval of the mission; `null` when it is not usable. */
  consumeApproval(approvalId: string): ApprovalRecord | null;
  /**
   * Events of this mission log about some risks, oldest first — how the decision learns
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
  createRequest(input: Omit<InsertRequestInput, 'missionId' | 'missionLogId'>): RequestRecord;
  /** Records an extra event beyond the one returned in the outcome. */
  recordEvent(event: UntypedNewEvent): EventRecord;
}

/** The limits of one accepted risk as `mission_policy` holds them. */
export interface StoredLimits {
  readonly gate?: Gate;
  readonly quota: number;
  readonly rateLimit: number;
  readonly rateWindowSeconds: number;
}

/** Which events of a mission log `riskEvents` returns. */
export interface RiskEventQuery {
  readonly kinds: readonly string[];
  /** The `risk_id` column of the events. */
  readonly riskIds: readonly RiskId[];
  /** `ts >= since`. */
  readonly since: Iso;
}

export interface DecisionOutcome {
  /** True increments every requested line's counter by one; false leaves them untouched. */
  readonly allow: boolean;
  /** Event written in the same transaction (e.g. `call-allowed`, `call-refused`). */
  readonly event?: UntypedNewEvent | null;
}

export interface DecideResult<R extends DecisionOutcome> {
  readonly outcome: R;
  readonly missionLog: MissionLogRecord;
  /** Counters after the transaction, for the requested lines. */
  readonly counters: ReadonlyMap<PolicyLineKey, number>;
}

export interface MissionLogsRepo {
  getByMission(missionId: string): Promise<MissionLogRecord | null>;
  /** "The mission log is born on the first call": idempotent creation. */
  getOrCreate(missionId: string): Promise<MissionLogRecord>;
  /**
   * Runs `decide` inside one `BEGIN IMMEDIATE` transaction with the current counters and,
   * when it allows, increments the counters of every requested line by one. The callback
   * must be synchronous and side-effect free apart from the `DecideContext` methods.
   */
  decideAndDecrement<R extends DecisionOutcome>(
    input: DecideInput,
    decide: (ctx: DecideContext) => R,
  ): Promise<DecideResult<R>>;
  counters(missionLogId: string, periodStart?: Iso): Promise<MissionLogCounterRecord[]>;
  recordEvent(missionLogId: string, event: UntypedNewEvent): Promise<EventRecord>;
  listEvents(missionLogId: string, options?: ListEventsOptions): Promise<EventRecord[]>;
  /**
   * The mission log timeline, newest first (`ts DESC, id DESC`), paged by keyset: `before`
   * is the last event of the previous page. `listEvents` with `order: 'desc'` gives the
   * same first page; this one resumes after a position.
   */
  listRecentEvents(missionLogId: string, options: RecentEventsOptions): Promise<EventRecord[]>;
  /**
   * The events of every mission log a viewer may read (the Activity's Timeline): scoped in
   * SQL before the filters and the keyset, like `AuditRepo.search`. Newest first; oldest
   * first when it reads the page newer than `after`. Each event carries its mission.
   */
  searchEvents(query: EventSearch): Promise<MissionEventRecord[]>;
  /**
   * The mission logs that hold an event or a counter older than `cutoff`: what a retention
   * sweep looks at. A superset of what it removes.
   */
  withHistoryBefore(cutoff: Iso): Promise<MissionLogRecord[]>;
  /**
   * Retention of one mission log's history, in one transaction. The only path that deletes
   * an event or a counter while its mission exists; the caller computes the bounds from
   * the mission's period (`budget/retention.ts`).
   */
  purgeHistory(missionLogId: string, bounds: HistoryPurgeBounds): Promise<HistoryPurged>;
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

/**
 * Whose mission log events a search may return: the mission logs of the missions one user
 * created or is a current member of, or every mission log (an operator). An empty scope
 * matches nothing.
 */
export interface EventScope {
  readonly missionCreatorUserId: string | null;
  /** A member row with `removed_at` set grants nothing. */
  readonly missionMemberUserId: string | null;
  readonly allMissions: boolean;
}

export interface EventSearch {
  readonly scope: EventScope;
  readonly missionId?: string;
  /**
   * Only call events: of one agent label (`null`: the calls that carried none), made
   * with a token of one of these holders (an empty list matches nothing), or both.
   */
  readonly calls?: {
    readonly agentLabel?: string | null;
    readonly holders?: { readonly kind: MissionTokenKind; readonly holders: readonly string[] };
  };
  /** Events strictly older than this position. */
  readonly before?: { readonly ts: Iso; readonly id: string };
  /** Events strictly newer than this position, read oldest first. Not with `before`. */
  readonly after?: { readonly ts: Iso; readonly id: string };
  readonly limit: number;
}

/** An event with the mission its mission log belongs to. */
export interface MissionEventRecord extends EventRecord {
  readonly missionId: string;
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

interface MissionLogRow {
  id: string;
  mission_id: string;
  created_at: string;
}

interface CounterRow {
  mission_log_id: string;
  resource_set_id: string;
  risk_id: string;
  period_start: string;
  consumed: number;
}

interface LimitsRow {
  gate: string;
  resource_set_id: string;
  risk_id: string;
  quota: number;
  rate_limit: number;
  rate_window_seconds: number;
}

interface EventRow {
  id: string;
  mission_log_id: string;
  ts: string;
  kind: string;
  risk_id: string | null;
  resource_set_id: string | null;
  actor_user_id: string | null;
  details_json: string | null;
}

const MISSION_LOG_COLUMNS = 'id, mission_id, created_at';
const COUNTER_COLUMNS = 'mission_log_id, resource_set_id, risk_id, period_start, consumed';
const EVENT_COLUMNS =
  'id, mission_log_id, ts, kind, risk_id, resource_set_id, actor_user_id, details_json';
/** `kind IN (…)` over the call kinds: constants of this file, never input. */
const CALL_KINDS_SQL = CALL_EVENT_KINDS.map((kind) => `'${kind}'`).join(', ');

function missionLogToRecord(row: MissionLogRow): MissionLogRecord {
  return { id: row.id, missionId: row.mission_id, createdAt: row.created_at };
}

function counterToRecord(row: CounterRow): MissionLogCounterRecord {
  return {
    missionLogId: row.mission_log_id,
    resourceSetId: row.resource_set_id,
    riskId: row.risk_id,
    periodStart: row.period_start,
    consumed: row.consumed,
  };
}

function eventToRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    missionLogId: row.mission_log_id,
    ts: row.ts,
    kind: row.kind,
    riskId: row.risk_id,
    resourceSetId: row.resource_set_id,
    actorUserId: row.actor_user_id,
    details: parseJsonObject(row.details_json, 'events.details_json'),
  };
}

/**
 * The mission-log side reads and writes that also run inside another repository's
 * transaction (a claim decision, the request sweeper). All synchronous and without a
 * transaction of their own: the caller holds it, so each stays atomic with the rest of
 * the caller's work.
 */
export interface MissionLogPrimitives {
  missionLogOfMission(missionId: string): MissionLogRecord | null;
  /** Appends one event at `now` and returns the stored row. */
  recordEvent(missionLogId: string, event: UntypedNewEvent, now: Iso): EventRecord;
  /** Every counter of the mission log in the period starting at `periodStart`, by line. */
  countersOfPeriod(missionLogId: string, periodStart: Iso): MissionLogCounterRecord[];
  /** Gives `amount` actions back on one line; false (nothing written) when fewer were consumed. */
  creditCounter(missionLogId: string, periodStart: Iso, line: RequestLine, amount: number): boolean;
  /** Events of the mission log of some kinds about some risks since an instant, oldest first. */
  riskEvents(missionLogId: string, query: RiskEventQuery): EventRecord[];
}

export function createMissionLogPrimitives(ctx: RepoContext): MissionLogPrimitives {
  const { db } = ctx;
  const byMission = db.prepare<[string], MissionLogRow>(
    `SELECT ${MISSION_LOG_COLUMNS} FROM mission_logs WHERE mission_id = ?`,
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
      string | null,
    ]
  >(
    `INSERT INTO events (${EVENT_COLUMNS}, agent_label, token_kind, token_holder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const eventById = db.prepare<[string], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`,
  );
  const countersOfPeriod = db.prepare<[string, string], CounterRow>(
    `SELECT ${COUNTER_COLUMNS} FROM mission_log_counters
     WHERE mission_log_id = ? AND period_start = ? ORDER BY risk_id, resource_set_id`,
  );
  const creditOne = db.prepare<[number, string, string, string, string, number]>(
    `UPDATE mission_log_counters SET consumed = consumed - ?
     WHERE mission_log_id = ? AND period_start = ? AND resource_set_id = ? AND risk_id = ?
       AND consumed >= ?`,
  );

  return {
    missionLogOfMission(missionId) {
      const row = byMission.get(missionId);
      return row ? missionLogToRecord(row) : null;
    },
    recordEvent(missionLogId, event, now) {
      const id = ctx.newId();
      const holder = holderColumns(event);
      insertEvent.run(
        id,
        missionLogId,
        now,
        event.kind,
        event.riskId ?? null,
        event.resourceSetId ?? null,
        event.actorUserId ?? null,
        toJson(event.details),
        agentLabelColumn(event),
        holder?.kind ?? null,
        holder?.holder ?? null,
      );
      return eventToRecord(requireRow(eventById.get(id), 'event', id));
    },
    countersOfPeriod(missionLogId, periodStart) {
      return countersOfPeriod.all(missionLogId, periodStart).map(counterToRecord);
    },
    creditCounter(missionLogId, periodStart, line, amount) {
      return (
        creditOne.run(amount, missionLogId, periodStart, line.resourceSetId, line.riskId, amount)
          .changes === 1
      );
    },
    riskEvents(missionLogId, query) {
      if (query.kinds.length === 0 || query.riskIds.length === 0) return [];
      return db
        .prepare<string[], EventRow>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE mission_log_id = ? AND ts >= ?
             AND kind IN (${placeholders(query.kinds.length)})
             AND risk_id IN (${placeholders(query.riskIds.length)})
           ORDER BY ts, id`,
        )
        .all(missionLogId, query.since, ...query.kinds, ...query.riskIds)
        .map(eventToRecord);
    },
  };
}

export function createMissionLogsRepo(ctx: RepoContext): MissionLogsRepo {
  const { db } = ctx;
  const primitives = createMissionLogPrimitives(ctx);
  const insertMissionLog = db.prepare<[string, string, string]>(
    `INSERT INTO mission_logs (id, mission_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (mission_id) DO NOTHING`,
  );
  const increment = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_log_counters (mission_log_id, resource_set_id, risk_id, period_start, consumed)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (mission_log_id, resource_set_id, risk_id, period_start)
     DO UPDATE SET consumed = mission_log_counters.consumed + 1`,
  );
  const countersAll = db.prepare<[string], CounterRow>(
    `SELECT ${COUNTER_COLUMNS} FROM mission_log_counters
     WHERE mission_log_id = ? ORDER BY period_start, risk_id, resource_set_id`,
  );
  const missionExists = db.prepare<[string], { one: number }>(
    'SELECT 1 AS one FROM missions WHERE id = ?',
  );
  const eventsSince = db.prepare<[string, string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE mission_log_id = ? AND ts >= ? ORDER BY ts, id LIMIT ?`,
  );
  const eventsAll = db.prepare<[string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE mission_log_id = ? ORDER BY ts, id LIMIT ?`,
  );
  const eventsRecent = db.prepare<[string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE mission_log_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
  );
  const eventsRecentBefore = db.prepare<[string, string, string, string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE mission_log_id = ? AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`,
  );
  // The calls of one label, and the calls without one. Separate statements rather than
  // `? IS NULL OR agent_label = ?`: Postgres cannot type a parameter that is only
  // compared with NULL. The index `events_mission_log_label_ts` serves the four of them.
  const CALLS = `SELECT ${EVENT_COLUMNS} FROM events WHERE mission_log_id = ? AND kind IN (${CALL_KINDS_SQL})`;
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

  // The calls made with a token of one holder (index `events_mission_log_holder_ts`).
  const callsOfHolder = db.prepare<[string, string, string, number], EventRow>(
    `${CALLS} AND token_kind = ? AND token_holder = ? ${NEWEST_FIRST}`,
  );
  const callsOfHolderBefore = db.prepare<
    [string, string, string, string, string, string, number],
    EventRow
  >(`${CALLS} AND token_kind = ? AND token_holder = ? ${KEYSET} ${NEWEST_FIRST}`);

  function getOrCreateSync(missionId: string, now: Iso): MissionLogRecord {
    // Checked first: with foreign keys on, the insert would otherwise surface a driver
    // error instead of the store's NotFoundError.
    if (!missionExists.get(missionId)) throw new NotFoundError('mission', missionId);
    insertMissionLog.run(ctx.newId(), missionId, now);
    return requireRow(
      primitives.missionLogOfMission(missionId) ?? undefined,
      'mission log',
      missionId,
    );
  }

  /** The distinct risk ids of some lines, for an `IN (…)` list. */
  function riskIdsOfLines(lines: readonly RequestLine[]): RiskId[] {
    return [...new Set(lines.map((line) => line.riskId))];
  }

  function readCounters(
    missionLogId: string,
    periodStart: Iso,
    lines: readonly RequestLine[],
  ): Map<PolicyLineKey, number> {
    const result = new Map<PolicyLineKey, number>(
      lines.map((l) => [policyLineKey(l.resourceSetId, l.riskId), 0]),
    );
    const riskIds = riskIdsOfLines(lines);
    if (riskIds.length === 0) return result;
    const rows = db
      .prepare<string[], CounterRow>(
        `SELECT ${COUNTER_COLUMNS} FROM mission_log_counters
         WHERE mission_log_id = ? AND period_start = ? AND risk_id IN (${placeholders(riskIds.length)})`,
      )
      .all(missionLogId, periodStart, ...riskIds);
    for (const row of rows) {
      const key = policyLineKey(row.resource_set_id, row.risk_id);
      if (result.has(key)) result.set(key, row.consumed);
    }
    return result;
  }

  function readLimits(
    missionId: string,
    lines: readonly RequestLine[],
  ): Map<PolicyLineKey, StoredLimits> {
    const result = new Map<PolicyLineKey, StoredLimits>();
    const riskIds = riskIdsOfLines(lines);
    if (riskIds.length === 0) return result;
    const wanted = new Set(lines.map((l) => policyLineKey(l.resourceSetId, l.riskId)));
    // A Postgres port reads these rows `FOR SHARE`, so that a limits update waits for
    // the decision (or the decision for the update) instead of interleaving.
    const rows = db
      .prepare<string[], LimitsRow>(
        `SELECT resource_set_id, risk_id, quota, rate_limit, rate_window_seconds, gate
         FROM mission_policy
         WHERE mission_id = ? AND risk_id IN (${placeholders(riskIds.length)})`,
      )
      .all(missionId, ...riskIds);
    for (const row of rows) {
      const key = policyLineKey(row.resource_set_id, row.risk_id);
      if (!wanted.has(key)) continue;
      result.set(key, {
        gate: parseEnum(GATES, row.gate, 'mission_policy.gate'),
        quota: row.quota,
        rateLimit: row.rate_limit,
        rateWindowSeconds: row.rate_window_seconds,
      });
    }
    return result;
  }

  const setsOfRisk = db.prepare<[string, string], { resource_set_id: string }>(
    `SELECT p.resource_set_id FROM mission_policy p
       JOIN mission_resource_sets s ON s.id = p.resource_set_id
     WHERE p.mission_id = ? AND p.risk_id = ? ORDER BY s.account_id, s.position`,
  );
  const firstSetOf = db.prepare<[string], { id: string }>(
    'SELECT id FROM mission_resource_sets WHERE mission_id = ? ORDER BY account_id, position LIMIT 1',
  );

  /** The lines of a decision: given, or each risk in every set that accepts it. */
  function linesOfInput(input: DecideInput): RequestLine[] {
    if ('lines' in input) return [...input.lines];
    return [...new Set(input.riskIds)].flatMap((riskId): RequestLine[] => {
      const sets = setsOfRisk.all(input.missionId, riskId).map((r) => r.resource_set_id);
      // A risk no set accepts is counted in the mission's first set: the decision refuses it.
      const fallback = sets.length === 0 ? firstSetOf.get(input.missionId)?.id : undefined;
      const all = fallback !== undefined ? [fallback] : sets;
      return all.map((resourceSetId) => ({ resourceSetId, riskId }));
    });
  }

  function recentRows(missionLogId: string, options: RecentEventsOptions): EventRow[] {
    const { before, limit, calls } = options;
    if (!calls) {
      return before
        ? eventsRecentBefore.all(missionLogId, before.ts, before.ts, before.id, limit)
        : eventsRecent.all(missionLogId, limit);
    }
    if ('holder' in calls) {
      const { kind, holder } = calls.holder;
      return before
        ? callsOfHolderBefore.all(
            missionLogId,
            kind,
            holder,
            before.ts,
            before.ts,
            before.id,
            limit,
          )
        : callsOfHolder.all(missionLogId, kind, holder, limit);
    }
    const label = calls.agentLabel;
    if (label === null) {
      return before
        ? callsUnlabelledBefore.all(missionLogId, before.ts, before.ts, before.id, limit)
        : callsUnlabelled.all(missionLogId, limit);
    }
    return before
      ? callsOfLabelBefore.all(missionLogId, label, before.ts, before.ts, before.id, limit)
      : callsOfLabel.all(missionLogId, label, limit);
  }

  const withHistory = db.prepare<[string, string], MissionLogRow>(
    `SELECT ${MISSION_LOG_COLUMNS} FROM mission_logs
     WHERE EXISTS (SELECT 1 FROM events e WHERE e.mission_log_id = mission_logs.id AND e.ts < ?)
        OR EXISTS (SELECT 1 FROM mission_log_counters c
                   WHERE c.mission_log_id = mission_logs.id AND c.period_start < ?)
     ORDER BY id`,
  );
  const purgeEventsBefore = db.prepare<[string, string]>(
    'DELETE FROM events WHERE mission_log_id = ? AND ts < ?',
  );
  const purgeCountersBefore = db.prepare<[string, string]>(
    'DELETE FROM mission_log_counters WHERE mission_log_id = ? AND period_start < ?',
  );

  return {
    async getByMission(missionId) {
      return primitives.missionLogOfMission(missionId);
    },
    async withHistoryBefore(cutoff) {
      return withHistory.all(cutoff, cutoff).map(missionLogToRecord);
    },
    async purgeHistory(missionLogId, bounds) {
      const { eventsBefore, keep, countersBefore } = bounds;
      return withImmediateTransaction(db, () => {
        const events =
          keep.kinds.length === 0
            ? purgeEventsBefore.run(missionLogId, eventsBefore).changes
            : db
                .prepare<string[]>(
                  `DELETE FROM events
                   WHERE mission_log_id = ? AND ts < ?
                     AND NOT (ts >= ? AND kind IN (${placeholders(keep.kinds.length)}))`,
                )
                .run(missionLogId, eventsBefore, keep.since, ...keep.kinds).changes;
        const counters =
          countersBefore === null
            ? 0
            : purgeCountersBefore.run(missionLogId, countersBefore).changes;
        return { events, counters };
      });
    },
    async getOrCreate(missionId) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => getOrCreateSync(missionId, now));
    },
    async decideAndDecrement(input, decide) {
      const now = nowIso(ctx);
      const seen = new Set<PolicyLineKey>();
      const lines = linesOfInput(input).filter((line) => {
        const key = policyLineKey(line.resourceSetId, line.riskId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return withImmediateTransaction(db, () => {
        const missionLog = getOrCreateSync(input.missionId, now);
        const counters = readCounters(missionLog.id, input.periodStart, lines);
        const context: DecideContext = {
          missionLog,
          counters,
          limits: readLimits(input.missionId, lines),
          now,
          findApprovals: (call) => findApprovalsSync(ctx, input.missionId, call, now),
          consumeApproval: (id) => consumeApprovalSync(ctx, input.missionId, id, now),
          riskEvents: (query) => primitives.riskEvents(missionLog.id, query),
          findOpenRequest: (lookup) => findOpenRequestSync(ctx, input.missionId, lookup, now),
          createRequest: (request) =>
            insertRequestSync(
              ctx,
              { ...request, missionId: input.missionId, missionLogId: missionLog.id },
              now,
            ),
          recordEvent: (event) => primitives.recordEvent(missionLog.id, event, now),
        };
        const outcome = decide(context);
        if (outcome.allow) {
          for (const line of lines) {
            increment.run(missionLog.id, line.resourceSetId, line.riskId, input.periodStart);
          }
        }
        if (outcome.event) primitives.recordEvent(missionLog.id, outcome.event, now);
        return {
          outcome,
          missionLog,
          counters: readCounters(missionLog.id, input.periodStart, lines),
        };
      });
    },
    async counters(missionLogId, periodStart) {
      return periodStart
        ? primitives.countersOfPeriod(missionLogId, periodStart)
        : countersAll.all(missionLogId).map(counterToRecord);
    },
    async recordEvent(missionLogId, event) {
      return primitives.recordEvent(missionLogId, event, nowIso(ctx));
    },
    async listEvents(missionLogId, options = {}) {
      const limit = options.limit ?? DEFAULT_LIST_LIMIT;
      if (!options.kinds && options.order !== 'desc') {
        const rows = options.since
          ? eventsSince.all(missionLogId, options.since, limit)
          : eventsAll.all(missionLogId, limit);
        return rows.map(eventToRecord);
      }
      const kinds = options.kinds ?? [];
      if (options.kinds && kinds.length === 0) return [];
      const direction = options.order === 'desc' ? 'DESC' : 'ASC';
      const where = ['mission_log_id = ?'];
      const params: (string | number)[] = [missionLogId];
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
    async listRecentEvents(missionLogId, options) {
      return recentRows(missionLogId, options).map(eventToRecord);
    },
    async searchEvents(query) {
      const { sql, params } = eventSearchStatement(query);
      return db
        .prepare<(string | number)[], EventRow & { mission_id: string }>(sql)
        .all(...params)
        .map((row) => ({ ...eventToRecord(row), missionId: row.mission_id }));
    },
  };
}

/**
 * The statement of `searchEvents`: the scope first, then the filters, then the keyset.
 * Plain subqueries and `IN` lists, as `AuditRepo.search`, so it stays portable.
 */
function eventSearchStatement(query: EventSearch): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]): void => {
    where.push(sql);
    params.push(...values);
  };
  const { scope } = query;
  const pieces: string[] = [];
  const scopeParams: string[] = [];
  if (scope.allMissions) pieces.push('1 = 1');
  if (scope.missionCreatorUserId !== null) {
    pieces.push('s.mission_id IN (SELECT id FROM missions WHERE creator_user_id = ?)');
    scopeParams.push(scope.missionCreatorUserId);
  }
  if (scope.missionMemberUserId !== null) {
    pieces.push(
      's.mission_id IN (SELECT mission_id FROM mission_members WHERE user_id = ? AND removed_at IS NULL)',
    );
    scopeParams.push(scope.missionMemberUserId);
  }
  add(pieces.length === 0 ? '1 = 0' : `(${pieces.join(' OR ')})`, ...scopeParams);

  if (query.missionId) add('s.mission_id = ?', query.missionId);
  const { calls } = query;
  if (calls) {
    add(`e.kind IN (${CALL_KINDS_SQL})`);
    if (calls.holders) {
      const { kind, holders } = calls.holders;
      if (holders.length === 0) add('1 = 0');
      else {
        add(
          `e.token_kind = ? AND e.token_holder IN (${placeholders(holders.length)})`,
          kind,
          ...holders,
        );
      }
    }
    if (calls.agentLabel === null) add('e.agent_label IS NULL');
    else if (calls.agentLabel !== undefined) add('e.agent_label = ?', calls.agentLabel);
  }
  if (query.before && query.after) {
    throw new InvariantError('event search: before and after are exclusive');
  }
  if (query.before) {
    const { ts, id } = query.before;
    add('(e.ts < ? OR (e.ts = ? AND e.id < ?))', ts, ts, id);
  }
  if (query.after) {
    const { ts, id } = query.after;
    add('(e.ts > ? OR (e.ts = ? AND e.id > ?))', ts, ts, id);
  }
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    throw new InvariantError('event search: limit must be a positive integer');
  }
  params.push(query.limit);
  const order = query.after ? 'e.ts ASC, e.id ASC' : 'e.ts DESC, e.id DESC';
  const columns = EVENT_COLUMNS.split(', ')
    .map((column) => `e.${column}`)
    .join(', ');
  return {
    sql: `SELECT ${columns}, s.mission_id AS mission_id
          FROM events e JOIN mission_logs s ON s.id = e.mission_log_id
          WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    params,
  };
}
