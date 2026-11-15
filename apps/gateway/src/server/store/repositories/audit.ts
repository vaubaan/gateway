/**
 * Audit repository — append, read, and the only legitimate purge path.
 *
 * Spec §6 "immutable audit", §8 (fields, 90-day default retention). Entries are
 * `@vaubaan/gateway-core`'s `AuditEntry`. The schema's triggers abort every
 * UPDATE and every DELETE that happens outside a purge window; `purgeOlderThan` opens
 * that window inside its own transaction.
 *
 * A call entry's accepted-risk snapshot is stored once per distinct set
 * (`audit_risk_sets`, content-addressed) and its `audit_risks` rows are the risks the
 * call touched only (ADR audit-risk-snapshot-stored-once). Entries written before
 * migration 0022 carry no set and read their snapshot from their own rows.
 */

import { createHash } from 'node:crypto';

import type {
  AdminAct,
  AdminAuditEntry,
  AuditDecision,
  AuditEntry,
  CallAuditEntry,
} from '@vaubaan/gateway-core';
import {
  isMissionTokenKind,
  isRefusalCode,
  type MissionTokenKind,
  type RefusalCode,
  type Slice,
} from '@vaubaan/shared';
import { withImmediateTransaction } from '../db.ts';
import type { EventScope } from './sessions.ts';
import { InvariantError } from '../errors.ts';
import type { Iso, Principal, RiskId } from '../types.ts';
import {
  DEFAULT_LIST_LIMIT,
  MS_PER_DAY,
  parseEnum,
  parseJson,
  placeholders,
  principalPredicate,
  requireColumn,
  requireRow,
  toJson,
  type RepoContext,
} from './context.ts';
import { ADMIN_ACTS, ADMIN_OBJECT_TYPES, AUDIT_DECISIONS, AUDIT_KINDS } from './enums.ts';

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

/**
 * One `audit_risks` row: a risk the call touched — or, on an entry written before
 * migration 0022, any risk of its accepted snapshot.
 */
export interface AuditRiskRow {
  readonly riskId: RiskId;
  /** In the mission's accepted risks at call time (snapshot). */
  readonly accepted: boolean;
  /** Touched by this call. */
  readonly touched: boolean;
  /** Remaining budget after the call, when known (touched risks only from 0022 on). */
  readonly remaining: number | null;
}

export type AuditRecord =
  | ({ readonly id: string; readonly risks: readonly AuditRiskRow[] } & CallAuditEntry)
  | ({ readonly id: string } & AdminAuditEntry);

export interface AuditFilter {
  readonly missionId?: string;
  readonly kind?: 'call' | 'admin';
  /** Administrative entries of this act only. */
  readonly act?: AdminAct;
  /** Administrative entries of this actor only. */
  readonly userId?: string;
  readonly since?: Iso;
  readonly until?: Iso;
  readonly limit?: number;
}

/**
 * Whose audit a search may return (spec §4.2 "Audit", §6): the entries about the
 * missions one user created and about the accounts some principals own, plus —
 * for an operator — every administrative entry. A search always carries a scope;
 * an empty one (no creator, no member, no owner, `allAdmin` and `allCalls` false)
 * matches nothing.
 */
export interface AuditScope {
  /** Entries about the missions this user created (calls, acts on them, their requests). */
  readonly missionCreatorUserId: string | null;
  /**
   * Entries about the missions this user is a member of right now (calls, acts on
   * them, their requests): a removed member reads none of them, past ones included.
   */
  readonly missionMemberUserId: string | null;
  /** Entries about the accounts these principals own (calls through them, acts on them). */
  readonly accountOwners: readonly Principal[];
  /** Every administrative entry, whatever its object. */
  readonly allAdmin: boolean;
  /** Every call entry, whatever its mission and its account (an operator). */
  readonly allCalls: boolean;
}

/** Keyset position: the last entry of the previous page (`ts`, then `id`). */
export interface AuditCursor {
  readonly ts: Iso;
  readonly id: string;
}

export type AuditCallRecord = Extract<AuditRecord, { readonly kind: 'call' }>;

export interface CallLookup {
  readonly missionId: string;
  readonly tool: string;
  /** `arguments_hash`: the canonical fingerprint of the call's arguments. */
  readonly argumentsHash: string;
  /** Only entries refused with this code. */
  readonly refusalCode?: RefusalCode;
}

export interface AuditSearch {
  readonly scope: AuditScope;
  /** Calls of the mission, administrative acts on it and on its requests. */
  readonly missionId?: string;
  /** Acts performed by these users and calls of the missions they created. An empty
   *  list matches nothing. */
  readonly userIds?: readonly string[];
  /** Calls through the account and administrative acts on it. */
  readonly accountId?: string;
  /** Exact tool name (call entries only). */
  readonly tool?: string;
  /** Call entries only. */
  readonly decision?: AuditDecision;
  /** Exact agent label (call entries only). Attribution, as declared by the caller. */
  readonly agentLabel?: string;
  /**
   * Calls made with a token of these holders (call entries only): a kind, and the
   * user ids (`member`) or the token names (`named`). An empty list matches nothing.
   */
  readonly tokenHolders?: {
    readonly kind: MissionTokenKind;
    readonly holders: readonly string[];
  };
  readonly kind?: 'call' | 'admin';
  /** `ts >= since`. */
  readonly since?: Iso;
  /** `ts < until`. */
  readonly until?: Iso;
  /** Entries strictly older than this position (newest first). */
  readonly before?: AuditCursor;
  /**
   * Entries strictly newer than this position, read oldest first (`ts ASC, id ASC`): the
   * page before the current one, which the caller turns back to newest first. Not with
   * `before`.
   */
  readonly after?: AuditCursor;
  readonly limit: number;
}

/** One agent label seen on a mission's calls (attribution only, spec §3.3). */
export interface AgentLabelSeen {
  readonly label: string;
  readonly calls: number;
  readonly lastSeenAt: Iso;
}

/**
 * A mission's calls under one agent label over a span of time — or, for
 * `label: null`, the calls that carried none. Counts of audit entries: who
 * the callers said they were, never a budget (the counters are per risk and
 * shared by every agent, spec §3.2).
 */
export interface AgentLabelActivity {
  readonly label: string | null;
  readonly allowed: number;
  readonly refused: number;
  readonly lastSeenAt: Iso;
}

/**
 * A mission's calls made with the tokens of one holder over a span of time — or, for
 * `kind: null`, the calls written before tokens had a holder. Counts of audit entries:
 * who called, authenticated by the token; never a budget (one budget per mission,
 * however many tokens, spec §3.2).
 */
export interface TokenHolderActivity {
  readonly kind: MissionTokenKind | null;
  /** A user id (`member`) or a token name (`named`); `null` with `kind: null`. */
  readonly holder: string | null;
  readonly allowed: number;
  readonly refused: number;
  readonly lastSeenAt: Iso;
}

/**
 * The call entries of one mission, account and key holder over a span (Activity's
 * Overview): counted by decision, their bytes summed. Counts of audit entries, never a
 * budget. `kind: null` gathers the calls written before tokens had a holder.
 */
export interface CallTotalsRow {
  readonly missionId: string;
  /** `null` for a call refused before its account was resolved. */
  readonly accountId: string | null;
  readonly kind: MissionTokenKind | null;
  readonly holder: string | null;
  readonly allowed: number;
  readonly refused: number;
  /** Sums of the known counts (migration 0038); 0 when none is known. */
  readonly requestBytes: number;
  readonly responseBytes: number;
}

export interface CallTotalsQuery {
  /** The missions whose calls are summed: the Timeline's scope (`EventScope`). */
  readonly scope: EventScope;
  /** Inclusive lower bound of `ts`. */
  readonly since: Iso;
}

/**
 * When `appendUnlessLatest` holds its entry back: the most recent administrative entry
 * on the same object whose act is one of `among` carries the same act and was written
 * at or after `since`.
 */
export interface LatestActGuard {
  /** The acts that alternate on the object (`mission-orphaned` / `mission-restored`). */
  readonly among: readonly AdminAct[];
  /**
   * An equal act older than this does not hold the entry back: it records an earlier
   * change, not the one being written (an entry purged by retention, or a change no
   * entry recorded in between, must not suppress a new one).
   */
  readonly since: Iso;
}

export interface AuditRepo {
  append(entry: AuditEntry): Promise<AuditRecord>;
  /**
   * `append` for a change two writers may both have observed: the read of the latest
   * entry and the insert are one transaction, so the change is recorded once. Returns
   * `null` when the entry was held back (see `LatestActGuard`).
   */
  appendUnlessLatest(entry: AdminAuditEntry, guard: LatestActGuard): Promise<AuditRecord | null>;
  getById(id: string): Promise<AuditRecord | null>;
  list(filter?: AuditFilter): Promise<AuditRecord[]>;
  /**
   * The Audit page's query: scoped, filtered, newest first (`ts DESC, id DESC`), paged
   * by keyset; oldest first when it reads the page newer than `after`. Returns at most
   * `limit` records.
   */
  search(query: AuditSearch): Promise<AuditRecord[]>;
  /**
   * The most recent call entry of a mission for one tool and one argument fingerprint —
   * what the creator's view of an approval request reads the slices and the touched
   * risks from (spec §3.5: "only their fingerprint remains in the audit").
   */
  latestCall(query: CallLookup): Promise<AuditCallRecord | null>;
  /** Distinct agent labels of a mission's call entries, most recently seen first. */
  agentLabels(missionId: string): Promise<AgentLabelSeen[]>;
  /**
   * A mission's call entries in `[since, until)` (`until: null`: no upper bound), counted
   * per agent label and per decision, the unlabelled calls as `label: null`. Busiest
   * first, then by label.
   */
  agentLabelActivity(
    missionId: string,
    span: { readonly since: Iso; readonly until: Iso | null },
  ): Promise<AgentLabelActivity[]>;
  /**
   * A mission's call entries in `[since, until)` (`until: null`: no upper bound), counted
   * per token holder and per decision. Busiest first, then by holder.
   */
  tokenHolderActivity(
    missionId: string,
    span: { readonly since: Iso; readonly until: Iso | null },
  ): Promise<TokenHolderActivity[]>;
  /**
   * Allowed call entries touching `riskId` in `[since, until)` — the audit side of the
   * structural check "session counters agree with the audit" (spec §10).
   */
  /** Allowed call entries of the mission that touched the risk and were charged on the set. */
  countAllowedTouches(
    missionId: string,
    resourceSetId: string,
    riskId: RiskId,
    since: Iso,
    until: Iso,
  ): Promise<number>;
  /**
   * Call entries at or after `since`, counted by decision (the `audit_ts` index): the
   * calls of the day of the counters (spec §4.3 bis).
   */
  countCallsSince(since: Iso): Promise<CallDecisionCounts>;
  /**
   * The call entries since `query.since` of the missions in `query.scope`, one row per
   * mission, account and key holder (`audit_calls_overview`, migration 0038): one
   * statement for every mission of the Overview.
   */
  callTotals(query: CallTotalsQuery): Promise<CallTotalsRow[]>;
  /** Retention purge: deletes entries strictly older than `cutoff`. The only delete path. */
  purgeOlderThan(cutoff: Iso): Promise<number>;
  /** `purgeOlderThan(now - retentionDays)`; default 90 days (spec §8). */
  purgeByRetention(retentionDays?: number): Promise<number>;
}

/** How many call entries were allowed and refused. */
export interface CallDecisionCounts {
  readonly allowed: number;
  readonly refused: number;
}

interface AuditRow {
  id: string;
  ts: string;
  kind: string;
  mission_id: string | null;
  token_id: string | null;
  token_kind: string | null;
  token_holder: string | null;
  session_id: string | null;
  account_id: string | null;
  resource_ref: string | null;
  tool: string | null;
  arguments_hash: string | null;
  slices_json: string | null;
  decision: string | null;
  refusal_code: string | null;
  refusal_reason: string | null;
  approval_id: string | null;
  agent_label: string | null;
  upstream_latency_ms: number | null;
  upstream_error: string | null;
  request_bytes: number | null;
  response_bytes: number | null;
  client_ip: string | null;
  client_user_agent: string | null;
  user_id: string | null;
  act: string | null;
  object_type: string | null;
  object_id: string | null;
  before_json: string | null;
  after_json: string | null;
  delegated_client_id: string | null;
  accepted_set_id: string | null;
}

interface CallTotalsDbRow {
  mission_id: string;
  account_id: string | null;
  token_kind: string | null;
  token_holder: string | null;
  allowed: number;
  refused: number;
  request_bytes: number;
  response_bytes: number;
}

interface RiskRow {
  risk_id: string;
  accepted: number;
  touched: number;
  remaining: number | null;
}

/** The one ordered column list: SELECTs, the INSERT and its parameters derive from it. */
const AUDIT_COLUMNS = [
  'id',
  'ts',
  'kind',
  'mission_id',
  'token_id',
  'token_kind',
  'token_holder',
  'session_id',
  'account_id',
  'resource_ref',
  'tool',
  'arguments_hash',
  'slices_json',
  'decision',
  'refusal_code',
  'refusal_reason',
  'approval_id',
  'agent_label',
  'upstream_latency_ms',
  'upstream_error',
  'request_bytes',
  'response_bytes',
  'client_ip',
  'client_user_agent',
  'user_id',
  'act',
  'object_type',
  'object_id',
  'before_json',
  'after_json',
  'delegated_client_id',
  'accepted_set_id',
] as const satisfies readonly (keyof AuditRow)[];
type AuditColumn = (typeof AUDIT_COLUMNS)[number];
const COLUMNS = AUDIT_COLUMNS.join(', ');

type SqlParams = (string | number | null)[];

/** Positional parameters in `AUDIT_COLUMNS` order; columns the entry kind does not set are null. */
function toParams(values: Partial<Record<AuditColumn, string | number | null>>): SqlParams {
  return AUDIT_COLUMNS.map((column) => values[column] ?? null);
}

function callParams(id: string, e: CallAuditEntry, acceptedSetId: string): SqlParams {
  return toParams({
    id,
    ts: e.ts,
    kind: 'call',
    mission_id: e.mission_id,
    token_id: e.token_id,
    token_kind: e.token_kind,
    token_holder: e.token_holder,
    session_id: e.session_id,
    account_id: e.account_id,
    resource_ref: e.resource_ref,
    tool: e.tool,
    arguments_hash: e.arguments_hash,
    slices_json: toJson(e.slices_executed),
    decision: e.decision,
    refusal_code: e.refusal_code,
    refusal_reason: e.refusal_reason,
    approval_id: e.approval_id,
    agent_label: e.agent_label,
    upstream_latency_ms: e.upstream_latency_ms,
    upstream_error: e.upstream_error,
    request_bytes: e.request_bytes ?? null,
    response_bytes: e.response_bytes ?? null,
    client_ip: e.client_ip,
    client_user_agent: e.client_user_agent,
    accepted_set_id: acceptedSetId,
  });
}

function adminParams(id: string, e: AdminAuditEntry): SqlParams {
  return toParams({
    id,
    ts: e.ts,
    kind: 'admin',
    user_id: e.user_id,
    act: e.act,
    object_type: e.object.type,
    object_id: e.object.id,
    before_json: toJson(e.before ?? null),
    after_json: toJson(e.after ?? null),
    // An act through the `vaubaan` plugin: the mission whose key made the call.
    mission_id: e.via_mission_id ?? null,
    delegated_client_id: e.delegated_client_id ?? null,
  });
}

function isSlice(value: unknown): value is Slice {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { service?: unknown; path?: unknown; action?: unknown };
  return (
    typeof v.service === 'string' && Array.isArray(v.path) && (v.action === 'R' || v.action === 'W')
  );
}

function parseSlices(text: string | null): Slice[] {
  const value = parseJson(text);
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(isSlice)) {
    throw new InvariantError('audit.slices_json: expected a list of slices');
  }
  return value;
}

function riskToRecord(row: RiskRow): AuditRiskRow {
  return {
    riskId: row.risk_id,
    accepted: row.accepted === 1,
    touched: row.touched === 1,
    remaining: row.remaining,
  };
}

/**
 * One row per risk the call touched (a refused call's refused risk is one of them),
 * with its place in the snapshot and its remaining budget. An untouched risk has no
 * row: its remaining budget did not change, and its acceptance is in the set.
 */
function riskRows(e: CallAuditEntry): AuditRiskRow[] {
  const accepted = new Set(e.accepted_risks_snapshot);
  return [...new Set(e.risks_touched)].sort().map((riskId) => ({
    riskId,
    accepted: accepted.has(riskId),
    touched: true,
    remaining: e.remaining_budget?.[riskId] ?? null,
  }));
}

/** A distinct accepted set: its sorted members and its content address. */
interface AcceptedSet {
  readonly id: string;
  readonly riskIds: readonly RiskId[];
}

/**
 * The content address of an accepted set: SHA-256 (hex) of its sorted, distinct risk
 * ids joined by a line feed (a risk id never holds one). The same set has the same id
 * whatever the mission, the call or the order the snapshot listed it in.
 */
export function acceptedSetOf(snapshot: readonly RiskId[]): AcceptedSet {
  const riskIds = [...new Set(snapshot)].sort();
  const id = createHash('sha256').update(riskIds.join('\n'), 'utf8').digest('hex');
  return { id, riskIds };
}

const REQUESTS_OF_MISSION = 'SELECT id FROM requests WHERE mission_id';
const SHARES_OF_ACCOUNT = 'SELECT id FROM shares WHERE account_id';

/**
 * The WHERE clause of `search`: the scope first (what the viewer may see at all), then
 * the filters, then the keyset position. Plain subqueries and `IN` lists only, so the
 * statement is the same on Postgres.
 */
/** A piece of SQL with the values of its own placeholders, in order. */
export interface SqlPiece {
  readonly sql: string;
  readonly params: readonly string[];
}

/** `column IN (<subquery>)`: the subquery's values travel with it, wherever it is placed. */
function inSet(column: string, set: SqlPiece): SqlPiece {
  return { sql: `${column} IN (${set.sql})`, params: set.params };
}

/** Pieces joined by `OR`, between parentheses; their values in the same order. */
function anyOf(pieces: readonly SqlPiece[]): SqlPiece {
  return {
    sql: `(${pieces.map((piece) => piece.sql).join(' OR ')})`,
    params: pieces.flatMap((piece) => piece.params),
  };
}

const NOTHING: SqlPiece = { sql: '1 = 0', params: [] };
const EVERYTHING: SqlPiece = { sql: '1 = 1', params: [] };

/**
 * The visibility rule, as one predicate over `audit` (spec §4.2 "Audit", §8;
 * docs/spec/vaubaan-gateway.md). An entry is in the scope when:
 *
 *   call   — the scope holds every call, or its mission is one the viewer created
 *            or is a current member of, or its account is one they own;
 *   admin  — the scope holds every administrative entry, or its object is such a
 *            mission, a request of such a mission, an account they own, a share
 *            of such an account.
 *
 * A dimension the scope does not hold is an always-false piece, never a placeholder
 * value that happens to match nothing. Each piece carries its own values, so adding
 * a dimension cannot shift the placeholders of another.
 */
function scopePredicate(scope: AuditScope): SqlPiece {
  const owners = principalPredicate(scope.accountOwners, 'owner_user_id', 'owner_group_id');
  const created: SqlPiece =
    scope.missionCreatorUserId === null
      ? { sql: 'SELECT id FROM missions WHERE 1 = 0', params: [] }
      : {
          sql: 'SELECT id FROM missions WHERE creator_user_id = ?',
          params: [scope.missionCreatorUserId],
        };
  // A member row with `removed_at` set is a past membership: it grants nothing.
  const memberOf: SqlPiece =
    scope.missionMemberUserId === null
      ? { sql: 'SELECT mission_id FROM mission_members WHERE 1 = 0', params: [] }
      : {
          sql: 'SELECT mission_id FROM mission_members WHERE user_id = ? AND removed_at IS NULL',
          params: [scope.missionMemberUserId],
        };
  const ownAccounts: SqlPiece = {
    sql: `SELECT id FROM accounts WHERE ${owners.sql}`,
    params: owners.params,
  };
  const requestsOf = (missions: SqlPiece): SqlPiece => ({
    sql: `${REQUESTS_OF_MISSION} IN (${missions.sql})`,
    params: missions.params,
  });
  const sharesOf = (accounts: SqlPiece): SqlPiece => ({
    sql: `${SHARES_OF_ACCOUNT} IN (${accounts.sql})`,
    params: accounts.params,
  });
  const about = (type: string, ids: SqlPiece): SqlPiece => {
    const inIds = inSet('object_id', ids);
    return { sql: `(object_type = '${type}' AND ${inIds.sql})`, params: inIds.params };
  };

  const calls = anyOf([
    scope.allCalls ? EVERYTHING : NOTHING,
    inSet('mission_id', created),
    inSet('mission_id', memberOf),
    inSet('account_id', ownAccounts),
  ]);
  const admin = anyOf([
    scope.allAdmin ? EVERYTHING : NOTHING,
    about('mission', created),
    about('mission', memberOf),
    about('request', requestsOf(created)),
    about('request', requestsOf(memberOf)),
    about('account', ownAccounts),
    about('share', sharesOf(ownAccounts)),
  ]);
  return {
    sql: `((kind = 'call' AND ${calls.sql}) OR (kind = 'admin' AND ${admin.sql}))`,
    params: [...calls.params, ...admin.params],
  };
}

/**
 * `<column> IN` the missions of a Timeline scope (`EventScope`): created by the user,
 * of which they are a current member, or every mission. An empty scope matches nothing.
 */
export function missionScopePiece(column: string, scope: EventScope): SqlPiece {
  const pieces: SqlPiece[] = [];
  if (scope.allMissions) pieces.push(EVERYTHING);
  if (scope.missionCreatorUserId !== null) {
    pieces.push({
      sql: `${column} IN (SELECT id FROM missions WHERE creator_user_id = ?)`,
      params: [scope.missionCreatorUserId],
    });
  }
  if (scope.missionMemberUserId !== null) {
    pieces.push({
      sql: `${column} IN (SELECT mission_id FROM mission_members WHERE user_id = ? AND removed_at IS NULL)`,
      params: [scope.missionMemberUserId],
    });
  }
  return pieces.length === 0 ? NOTHING : anyOf(pieces);
}

function searchStatement(query: AuditSearch): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };

  const scoped = scopePredicate(query.scope);
  add(scoped.sql, ...scoped.params);

  if (query.missionId) {
    add(
      `(mission_id = ?
        OR (object_type = 'mission' AND object_id = ?)
        OR (object_type = 'request' AND object_id IN (${REQUESTS_OF_MISSION} = ?)))`,
      query.missionId,
      query.missionId,
      query.missionId,
    );
  }
  if (query.userIds) {
    const ids = query.userIds;
    if (ids.length === 0) add('1 = 0');
    else {
      const list = placeholders(ids.length);
      add(
        `(user_id IN (${list})
          OR mission_id IN (SELECT id FROM missions WHERE creator_user_id IN (${list})))`,
        ...ids,
        ...ids,
      );
    }
  }
  if (query.accountId) {
    add(
      "(account_id = ? OR (object_type = 'account' AND object_id = ?))",
      query.accountId,
      query.accountId,
    );
  }
  if (query.tool) add('tool = ?', query.tool);
  if (query.decision) add('decision = ?', query.decision);
  if (query.agentLabel) add("kind = 'call' AND agent_label = ?", query.agentLabel);
  if (query.tokenHolders) {
    const { kind, holders } = query.tokenHolders;
    if (holders.length === 0) add('1 = 0');
    else {
      add(
        `kind = 'call' AND token_kind = ? AND token_holder IN (${placeholders(holders.length)})`,
        kind,
        ...holders,
      );
    }
  }
  if (query.kind) add('kind = ?', query.kind);
  if (query.since) add('ts >= ?', query.since);
  if (query.until) add('ts < ?', query.until);
  if (query.before && query.after) {
    throw new InvariantError('audit search: before and after are exclusive');
  }
  if (query.before) {
    add('(ts < ? OR (ts = ? AND id < ?))', query.before.ts, query.before.ts, query.before.id);
  }
  if (query.after) {
    add('(ts > ? OR (ts = ? AND id > ?))', query.after.ts, query.after.ts, query.after.id);
  }
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    throw new InvariantError('audit search: limit must be a positive integer');
  }
  params.push(query.limit);
  const order = query.after ? 'ts ASC, id ASC' : 'ts DESC, id DESC';
  return {
    sql: `SELECT ${COLUMNS} FROM audit WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    params,
  };
}

export function createAuditRepo(ctx: RepoContext): AuditRepo {
  const { db } = ctx;
  const insert = db.prepare<SqlParams>(
    `INSERT INTO audit (${COLUMNS}) VALUES (${placeholders(AUDIT_COLUMNS.length)})`,
  );
  const insertRisk = db.prepare<[string, string, number, number, number | null]>(
    'INSERT INTO audit_risks (audit_id, risk_id, accepted, touched, remaining) VALUES (?, ?, ?, ?, ?)',
  );
  // `ON CONFLICT DO NOTHING`: the set is content-addressed, a second writer of the same
  // set has nothing to add. Same statement on Postgres.
  const insertSet = db.prepare<[string, number]>(
    'INSERT INTO audit_risk_sets (id, risk_count) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
  );
  const insertSetMember = db.prepare<[string, string]>(
    'INSERT INTO audit_risk_set_members (set_id, risk_id) VALUES (?, ?)',
  );
  const membersOf = db.prepare<[string], { risk_id: string }>(
    'SELECT risk_id FROM audit_risk_set_members WHERE set_id = ? ORDER BY risk_id',
  );
  const setSize = db.prepare<[string], { risk_count: number }>(
    'SELECT risk_count FROM audit_risk_sets WHERE id = ?',
  );
  const byId = db.prepare<[string], AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE id = ?`);
  const risksOf = db.prepare<[string], RiskRow>(
    'SELECT risk_id, accepted, touched, remaining FROM audit_risks WHERE audit_id = ? ORDER BY risk_id',
  );
  const insertResourceSet = db.prepare<[string, string]>(
    'INSERT INTO audit_resource_sets (audit_id, resource_set_id) VALUES (?, ?)',
  );
  const resourceSetsOf = db.prepare<[string], { resource_set_id: string }>(
    'SELECT resource_set_id FROM audit_resource_sets WHERE audit_id = ? ORDER BY resource_set_id',
  );
  const countTouches = db.prepare<[string, string, string, string, string], { n: number }>(
    `SELECT COUNT(*) AS n FROM audit a
       JOIN audit_risks r ON r.audit_id = a.id
       JOIN audit_resource_sets s ON s.audit_id = a.id
     WHERE a.kind = 'call' AND a.decision = 'allowed' AND a.mission_id = ?
       AND s.resource_set_id = ? AND r.risk_id = ? AND r.touched = 1 AND a.ts >= ? AND a.ts < ?`,
  );
  const callsSince = db.prepare<[string], { readonly decision: string; readonly n: number }>(
    `SELECT decision, COUNT(*) AS n FROM audit
     WHERE ts >= ? AND kind = 'call' GROUP BY decision`,
  );
  const openWindow = db.prepare<[string]>(
    'INSERT INTO audit_purge_guard (id, cutoff) VALUES (1, ?)',
  );
  const closeWindow = db.prepare<[]>('DELETE FROM audit_purge_guard WHERE id = 1');
  const purgeRisks = db.prepare<[string]>(
    'DELETE FROM audit_risks WHERE audit_id IN (SELECT id FROM audit WHERE ts < ?)',
  );
  const purgeResourceSets = db.prepare<[string]>(
    'DELETE FROM audit_resource_sets WHERE audit_id IN (SELECT id FROM audit WHERE ts < ?)',
  );
  const purge = db.prepare<[string]>('DELETE FROM audit WHERE ts < ?');
  // The sets no remaining entry references, once the old entries are gone (same window).
  const UNREFERENCED =
    'NOT IN (SELECT accepted_set_id FROM audit WHERE accepted_set_id IS NOT NULL)';
  const purgeSetMembers = db.prepare<[]>(
    `DELETE FROM audit_risk_set_members WHERE set_id ${UNREFERENCED}`,
  );
  const purgeSets = db.prepare<[]>(`DELETE FROM audit_risk_sets WHERE id ${UNREFERENCED}`);
  const labelsOf = db.prepare<[string], { label: string; calls: number; last_seen: string }>(
    `SELECT agent_label AS label, COUNT(*) AS calls, MAX(ts) AS last_seen FROM audit
     WHERE kind = 'call' AND mission_id = ? AND agent_label IS NOT NULL
     GROUP BY agent_label ORDER BY last_seen DESC, agent_label`,
  );

  // Plain aggregates and CASE. Two statements, a bounded span and an open one, rather
  // than one with `? IS NULL OR ts < ?`: Postgres cannot infer the type of a parameter
  // that is only compared to NULL (same reason as `latestCallOf` / `latestRefusedCallOf`
  // below). On Postgres the driver returns SUM as text: map with `Number()` at the port.
  interface LabelActivityRow {
    label: string | null;
    allowed: number;
    refused: number;
    last_seen: string;
  }
  const LABEL_ACTIVITY = `SELECT agent_label AS label,
            SUM(CASE WHEN decision = 'allowed' THEN 1 ELSE 0 END) AS allowed,
            SUM(CASE WHEN decision = 'refused' THEN 1 ELSE 0 END) AS refused,
            MAX(ts) AS last_seen
     FROM audit
     WHERE kind = 'call' AND mission_id = ? AND ts >= ?`;
  const labelActivityOpen = db.prepare<[string, string], LabelActivityRow>(
    `${LABEL_ACTIVITY} GROUP BY agent_label`,
  );
  const labelActivityUntil = db.prepare<[string, string, string], LabelActivityRow>(
    `${LABEL_ACTIVITY} AND ts < ? GROUP BY agent_label`,
  );

  interface HolderActivityRow {
    token_kind: string | null;
    token_holder: string | null;
    allowed: number;
    refused: number;
    last_seen: string;
  }
  // Same shape and same two-statement reason as the label activity above.
  const HOLDER_ACTIVITY = `SELECT token_kind, token_holder,
            SUM(CASE WHEN decision = 'allowed' THEN 1 ELSE 0 END) AS allowed,
            SUM(CASE WHEN decision = 'refused' THEN 1 ELSE 0 END) AS refused,
            MAX(ts) AS last_seen
     FROM audit
     WHERE kind = 'call' AND mission_id = ? AND ts >= ?`;
  const holderActivityOpen = db.prepare<[string, string], HolderActivityRow>(
    `${HOLDER_ACTIVITY} GROUP BY token_kind, token_holder`,
  );
  const holderActivityUntil = db.prepare<[string, string, string], HolderActivityRow>(
    `${HOLDER_ACTIVITY} AND ts < ? GROUP BY token_kind, token_holder`,
  );

  const latestCallOf = db.prepare<[string, string, string], AuditRow>(
    `SELECT ${COLUMNS} FROM audit
     WHERE kind = 'call' AND mission_id = ? AND tool = ? AND arguments_hash = ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
  );
  const latestRefusedCallOf = db.prepare<[string, string, string, string], AuditRow>(
    `SELECT ${COLUMNS} FROM audit
     WHERE kind = 'call' AND mission_id = ? AND tool = ? AND arguments_hash = ? AND refusal_code = ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
  );

  function toRecord(row: AuditRow): AuditRecord {
    const kind = parseEnum(AUDIT_KINDS, row.kind, 'audit.kind');
    return kind === 'admin' ? toAdminRecord(row) : toCallRecord(row);
  }

  function toAdminRecord(row: AuditRow): AuditRecord {
    // `act` and `object_type` have no schema CHECK: the lists written from gateway-core's
    // unions are the only guard, so a value the code does not know is refused here.
    return {
      id: row.id,
      kind: 'admin',
      ts: row.ts,
      user_id: requireColumn(row.user_id, 'audit.user_id'),
      act: parseEnum(ADMIN_ACTS, requireColumn(row.act, 'audit.act'), 'audit.act'),
      object: {
        type: parseEnum(
          ADMIN_OBJECT_TYPES,
          requireColumn(row.object_type, 'audit.object_type'),
          'audit.object_type',
        ),
        id: requireColumn(row.object_id, 'audit.object_id'),
      },
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      via_mission_id: row.mission_id,
      delegated_client_id: row.delegated_client_id,
    };
  }

  /** The members of a stored set, checked against the count written with it. */
  function acceptedSetMembers(setId: string): RiskId[] {
    const size = requireRow(setSize.get(setId), 'audit_risk_sets', setId).risk_count;
    const members = membersOf.all(setId).map((m) => m.risk_id);
    if (members.length !== size) {
      throw new InvariantError(
        `audit_risk_sets ${setId}: ${members.length} members stored, ${size} expected`,
      );
    }
    return members;
  }

  /** Writes the set unless it is already stored; returns its id. Inside the append's transaction. */
  function storeAcceptedSet(set: AcceptedSet): string {
    if (insertSet.run(set.id, set.riskIds.length).changes === 1) {
      for (const riskId of set.riskIds) insertSetMember.run(set.id, riskId);
    }
    return set.id;
  }

  function toCallRecord(row: AuditRow): AuditCallRecord {
    // perf: up to three small queries per call entry (rows, set size, members); a Postgres
    // port reads a page's risks and sets in one statement each.
    const risks = risksOf.all(row.id).map(riskToRecord);
    const remaining = risks.filter((r) => r.remaining !== null);
    // An entry written before migration 0022 has no set: its snapshot is its own rows.
    const accepted =
      row.accepted_set_id === null
        ? risks.filter((r) => r.accepted).map((r) => r.riskId)
        : acceptedSetMembers(row.accepted_set_id);
    const refusalCode = row.refusal_code;
    if (refusalCode !== null && !isRefusalCode(refusalCode)) {
      throw new InvariantError(`audit.refusal_code: unexpected value '${refusalCode}'`);
    }
    const tokenKind = row.token_kind;
    if (tokenKind !== null && !isMissionTokenKind(tokenKind)) {
      throw new InvariantError(`audit.token_kind: unexpected value '${tokenKind}'`);
    }
    return {
      id: row.id,
      kind: 'call',
      ts: row.ts,
      mission_id: requireColumn(row.mission_id, 'audit.mission_id'),
      token_id: row.token_id,
      token_kind: tokenKind,
      token_holder: tokenKind === null ? null : row.token_holder,
      session_id: row.session_id,
      account_id: row.account_id,
      resource_ref: row.resource_ref,
      tool: requireColumn(row.tool, 'audit.tool'),
      arguments_hash: requireColumn(row.arguments_hash, 'audit.arguments_hash'),
      slices_executed: parseSlices(row.slices_json),
      risks_touched: risks.filter((r) => r.touched).map((r) => r.riskId),
      accepted_risks_snapshot: accepted,
      decision: parseEnum(
        AUDIT_DECISIONS,
        requireColumn(row.decision, 'audit.decision'),
        'audit.decision',
      ),
      refusal_code: refusalCode,
      refusal_reason: row.refusal_reason,
      approval_id: row.approval_id,
      remaining_budget: remaining.length
        ? Object.fromEntries(remaining.map((r) => [r.riskId, r.remaining ?? 0]))
        : null,
      agent_label: row.agent_label,
      upstream_latency_ms: row.upstream_latency_ms,
      upstream_error: row.upstream_error,
      request_bytes: row.request_bytes,
      response_bytes: row.response_bytes,
      client_ip: row.client_ip,
      client_user_agent: row.client_user_agent,
      resource_set_ids: resourceSetsOf.all(row.id).map((r) => r.resource_set_id),
      risks,
    };
  }

  function requireEntry(id: string): AuditRecord {
    return toRecord(requireRow(byId.get(id), 'audit', id));
  }

  async function purgeOlderThan(cutoff: Iso): Promise<number> {
    return withImmediateTransaction(db, () => {
      openWindow.run(cutoff);
      try {
        purgeRisks.run(cutoff);
        purgeResourceSets.run(cutoff);
        const purged = purge.run(cutoff).changes;
        purgeSetMembers.run();
        purgeSets.run();
        return purged;
      } finally {
        closeWindow.run();
      }
    });
  }

  return {
    async append(entry) {
      const id = ctx.newId();
      const risks = entry.kind === 'call' ? riskRows(entry) : [];
      withImmediateTransaction(db, () => {
        const params =
          entry.kind === 'call'
            ? callParams(id, entry, storeAcceptedSet(acceptedSetOf(entry.accepted_risks_snapshot)))
            : adminParams(id, entry);
        insert.run(...params);
        if (entry.kind === 'call') {
          for (const setId of new Set(entry.resource_set_ids ?? [])) {
            insertResourceSet.run(id, setId);
          }
        }
        for (const r of risks) {
          insertRisk.run(id, r.riskId, r.accepted ? 1 : 0, r.touched ? 1 : 0, r.remaining);
        }
      });
      return requireEntry(id);
    },
    async appendUnlessLatest(entry, guard) {
      if (guard.among.length === 0 || !guard.among.includes(entry.act)) {
        throw new InvariantError('audit: the guarded acts must include the act being written');
      }
      const id = ctx.newId();
      // An `IN` list of bound values and a keyset order: the same statement on Postgres,
      // where the transaction must be SERIALIZABLE (or hold a per-object advisory lock)
      // for the read and the insert to stay one step. `ORDER BY ts DESC, id DESC` is
      // insertion order for the entries one process wrote (`store/ids.ts`).
      const latest = db.prepare<string[], { act: string; ts: string }>(
        `SELECT act, ts FROM audit
         WHERE kind = 'admin' AND object_type = ? AND object_id = ?
           AND act IN (${placeholders(guard.among.length)})
         ORDER BY ts DESC, id DESC LIMIT 1`,
      );
      const written = withImmediateTransaction(db, () => {
        const last = latest.get(entry.object.type, entry.object.id, ...guard.among);
        if (last && last.act === entry.act && last.ts >= guard.since) return false;
        insert.run(...adminParams(id, entry));
        return true;
      });
      return written ? requireEntry(id) : null;
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async list(filter = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.missionId) {
        where.push('mission_id = ?');
        params.push(filter.missionId);
      }
      if (filter.kind) {
        where.push('kind = ?');
        params.push(filter.kind);
      }
      if (filter.act) {
        where.push('act = ?');
        params.push(filter.act);
      }
      if (filter.userId) {
        where.push('user_id = ?');
        params.push(filter.userId);
      }
      if (filter.since) {
        where.push('ts >= ?');
        params.push(filter.since);
      }
      if (filter.until) {
        where.push('ts < ?');
        params.push(filter.until);
      }
      params.push(filter.limit ?? DEFAULT_LIST_LIMIT);
      const sql = `SELECT ${COLUMNS} FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts, id LIMIT ?`;
      return db
        .prepare<(string | number)[], AuditRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async search(query) {
      const { sql, params } = searchStatement(query);
      return db
        .prepare<(string | number)[], AuditRow>(sql)
        .all(...params)
        .map(toRecord);
    },
    async latestCall(query) {
      const row = query.refusalCode
        ? latestRefusedCallOf.get(
            query.missionId,
            query.tool,
            query.argumentsHash,
            query.refusalCode,
          )
        : latestCallOf.get(query.missionId, query.tool, query.argumentsHash);
      return row ? toCallRecord(row) : null;
    },
    async agentLabels(missionId) {
      return labelsOf
        .all(missionId)
        .map((r) => ({ label: r.label, calls: r.calls, lastSeenAt: r.last_seen }));
    },
    async agentLabelActivity(missionId, span) {
      const rows =
        span.until === null
          ? labelActivityOpen.all(missionId, span.since)
          : labelActivityUntil.all(missionId, span.since, span.until);
      return rows
        .map((r) => ({
          label: r.label,
          allowed: r.allowed,
          refused: r.refused,
          lastSeenAt: r.last_seen,
        }))
        .sort(
          (a, b) =>
            b.allowed + b.refused - (a.allowed + a.refused) ||
            (a.label ?? '').localeCompare(b.label ?? ''),
        );
    },
    async tokenHolderActivity(missionId, span) {
      const rows =
        span.until === null
          ? holderActivityOpen.all(missionId, span.since)
          : holderActivityUntil.all(missionId, span.since, span.until);
      return rows
        .map((r) => {
          const kind = isMissionTokenKind(r.token_kind) ? r.token_kind : null;
          return {
            kind,
            holder: kind === null ? null : r.token_holder,
            allowed: r.allowed,
            refused: r.refused,
            lastSeenAt: r.last_seen,
          };
        })
        .sort(
          (a, b) =>
            b.allowed + b.refused - (a.allowed + a.refused) ||
            (a.holder ?? '').localeCompare(b.holder ?? ''),
        );
    },
    async countAllowedTouches(missionId, resourceSetId, riskId, since, until) {
      return countTouches.get(missionId, resourceSetId, riskId, since, until)?.n ?? 0;
    },
    async callTotals(query) {
      const scoped = missionScopePiece('mission_id', query.scope);
      // `COALESCE(SUM(…), 0)`: an entry with no count adds nothing; plain SQL on Postgres
      // too, where the driver returns SUM as text (map with `Number()` at the port).
      const rows = db
        .prepare<(string | number)[], CallTotalsDbRow>(
          `SELECT mission_id, account_id, token_kind, token_holder,
                  SUM(CASE WHEN decision = 'allowed' THEN 1 ELSE 0 END) AS allowed,
                  SUM(CASE WHEN decision = 'refused' THEN 1 ELSE 0 END) AS refused,
                  COALESCE(SUM(request_bytes), 0) AS request_bytes,
                  COALESCE(SUM(response_bytes), 0) AS response_bytes
           FROM audit
           WHERE kind = 'call' AND ts >= ? AND ${scoped.sql}
           GROUP BY mission_id, account_id, token_kind, token_holder`,
        )
        .all(query.since, ...scoped.params);
      return rows.map((r) => {
        const kind = isMissionTokenKind(r.token_kind) ? r.token_kind : null;
        return {
          missionId: r.mission_id,
          accountId: r.account_id,
          kind,
          holder: kind === null ? null : r.token_holder,
          allowed: r.allowed,
          refused: r.refused,
          requestBytes: r.request_bytes,
          responseBytes: r.response_bytes,
        };
      });
    },
    async countCallsSince(since) {
      let allowed = 0;
      let refused = 0;
      for (const row of callsSince.all(since)) {
        if (row.decision === 'allowed') allowed = row.n;
        else if (row.decision === 'refused') refused = row.n;
      }
      return { allowed, refused };
    },
    purgeOlderThan,
    async purgeByRetention(retentionDays = DEFAULT_AUDIT_RETENTION_DAYS) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        throw new InvariantError('retention must be a positive number of days');
      }
      const cutoff = new Date(ctx.clock.now().getTime() - retentionDays * MS_PER_DAY);
      return purgeOlderThan(cutoff.toISOString());
    },
  };
}
