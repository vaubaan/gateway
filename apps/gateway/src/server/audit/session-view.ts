/**
 * `MissionSessionService` — what the Mission session page reads (spec §4.2
 * "Mission session — event timeline, counters per risk and per period, gate
 * per risk, open requests"; §3.3 the session and the remaining budget).
 *
 * Read-only. The mission's creator, and its members (spec §11.2 "What a member
 * sees": the whole session; arguments are never shown, and requests stay the
 * creator's): "does not exist" and "not yours" are the same answer, as on the
 * mission detail page. Open requests are listed by link to the creator's view
 * of the request (`/waiting/<id>`): their arguments stay there, and a
 * member is given no link (`path: null`) — only the creator answers. An event shows the fields named below and nothing
 * else of its details, read through `parseEventDetails` (`@vaubaan/shared`):
 * an event whose stored details do not have the shape of its kind is listed
 * with its kind, time, risk and actor, and no detail. What a page says of
 * each kind is the page's (`app/(app)/missions/[id]/session/event-words.ts`).
 *
 * The gate of a risk is two facts: the mission's own `gate`, and
 * `gate_open_until` when the creator opened it "for the rest of the period"
 * (spec §3.5). Both are on the risk row: `approval` alone would be wrong while
 * calls pass.
 *
 * The counters are the store's, as they stand: a granted claim (period reset,
 * quota extension) lowers them, so "counted" can go down during a period. The
 * `reset` / `extension` events of the timeline say how much was given back.
 *
 * Agent labels (spec §7.9 "the session and the audit tell who did what"). A
 * label is what a caller declared about itself: attribution, never an
 * identity, with no effect on what is allowed or counted (spec §0). Two reads
 * are built on it, both informational:
 *
 *   - `label_activity`: the mission's calls of the current period per label,
 *     allowed and refused, the unlabelled ones as `label: null`. Counts of
 *     audit entries — NOT a budget: the quota is per risk and shared by every
 *     agent, so these numbers neither add up to it (a call touching two risks
 *     is one call) nor bound anyone;
 *   - a timeline filter: the call events of one label, or the unlabelled ones.
 *     Events that are not calls (requests, resets, rotations…) carry no label
 *     and are left out of a filtered timeline. The repository filters on the
 *     `events.agent_label` column (migration 0008): a filtered page is one
 *     indexed read, paged by the same keyset as the whole timeline.
 *
 * Token holders (spec §8 "the token used and its holder"). Unlike a label, the
 * holder of a call is authenticated: it is the member, or the named token,
 * whose token the call presented. The same two reads exist per holder —
 * `holder_activity` (calls of the current period per holder, NOT a budget: all
 * the tokens of a mission draw from one) and a timeline filter on the
 * `events.token_kind` / `events.token_holder` columns (migration 0010). A call
 * stored before tokens had a holder is listed as unattributed.
 */
import {
  isMissionTokenKind,
  parseEventDetails,
  type Gate,
  type MissionPolicyEntry,
  type MissionTokenKind,
  type RequestClosedState,
  type RequestKind,
  type RiskId,
  type SessionEventDetails,
} from '@vaubaan/shared';

import type { Subject } from '../authority';
import type { MissionState } from '../budget';
import type { MissionDetail, MissionRole, MissionService, SeverityLevel } from '../missions';
import { missionChangeClauses } from '../../lib/missions/change-words';
import { isDecidable } from '../requests/state';
import { inboxRequestPath } from '../requests/url';
import type {
  AgentLabelActivity,
  AgentLabelSeen,
  AuditCursor,
  Store,
  TokenHolderActivity,
} from '../store';
import type { Clock } from '../store/clock';
import type { EventRecord, RequestRecord, SessionCounterRecord } from '../store/types';

export const SESSION_EVENTS_PAGE_SIZE = 100;
/** How many past periods the counters table shows, newest first. */
export const PAST_PERIODS_SHOWN = 7;

/** Which events of the timeline are listed. */
export type SessionTimelineFilter =
  | { readonly kind: 'all' }
  /** The calls that carried this agent label. */
  | { readonly kind: 'label'; readonly label: string }
  /** The calls that carried no label. */
  | { readonly kind: 'unlabelled' }
  /** The calls made with a token of this holder (a user id, or a token name). */
  | { readonly kind: 'holder'; readonly holder: SessionHolderRef };

/** A token holder as the store keeps it: the kind, and the user id or the token name. */
export interface SessionHolderRef {
  readonly kind: MissionTokenKind;
  readonly key: string;
}

/** A holder with what a page shows: the member's email, or the token's name. */
export interface SessionHolderView extends SessionHolderRef {
  readonly label: string;
}

const HOLDER_PARAM_SEPARATOR = ':';

/** `member:<user id>` / `named:<name>`: a holder in a query string. */
export function holderParam(holder: SessionHolderRef): string {
  return `${holder.kind}${HOLDER_PARAM_SEPARATOR}${holder.key}`;
}

/** The holder a query-string value names; `null` when it names none. */
export function parseHolderParam(value: string): SessionHolderRef | null {
  const at = value.indexOf(HOLDER_PARAM_SEPARATOR);
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  const key = value.slice(at + 1);
  return isMissionTokenKind(kind) && key.length > 0 ? { kind, key } : null;
}

export const ALL_EVENTS: SessionTimelineFilter = { kind: 'all' };

const MS_PER_SECOND = 1000;

export interface SessionRiskRow extends MissionPolicyEntry {
  readonly label: string;
  readonly level: SeverityLevel | null;
  /** Actions counted this period, net of what granted claims gave back; `null`
   *  when the mission is not active. */
  readonly consumed: number | null;
  /** Actions left this period; `null` when the mission is not active. */
  readonly remaining: number | null;
  readonly exhausted: boolean;
  /**
   * End of the period the creator opened this risk's gate for: until then calls
   * pass without asking although `gate` reads `approval`. `null` otherwise.
   */
  readonly gate_open_until: string | null;
}

export interface SessionPeriodRow {
  readonly start: string;
  /** `null` for a one-off mission (its single period never ends). */
  readonly end: string | null;
  readonly current: boolean;
  /** Actions counted per risk; a risk with no row consumed nothing. */
  readonly consumed: Readonly<Record<RiskId, number>>;
}

export interface SessionEventView {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  /** The risks the event concerns (touched, refused on, requested, extended…). */
  readonly risk_ids: readonly RiskId[];
  readonly actor_email: string | null;
  readonly tool: string | null;
  readonly refusal_code: string | null;
  readonly agent_label: string | null;
  /**
   * Whose token it was: the holder of the token a call presented, or of the
   * token a `rotation` / `revocation` is about. `null` for the other kinds, for
   * a mission-wide revocation, and for a call stored before tokens had a holder.
   */
  readonly holder: SessionHolderView | null;
  /** Remaining quota per touched risk after an allowed call. */
  readonly remaining: Readonly<Record<RiskId, number>> | null;
  readonly request_id: string | null;
  /**
   * The kind of the request `request_id` names. A refused call does not store
   * it: it follows from the refusal code (`requestKindOfRefusal`).
   */
  readonly request_kind: RequestKind | null;
  /** How a `request` event closed (refused, expired); `null` for the dropped one. */
  readonly request_state: RequestClosedState | null;
  /** How many approvals an allowed call consumed. */
  readonly approvals_consumed: number;
  /** The gate a `gate-changed` event set, and the one it replaced. */
  readonly gate: Gate | null;
  readonly gate_before: Gate | null;
  /** End of the period a `gate-opened` event opened the gate for. */
  readonly gate_open_until: string | null;
  /** The limits a `limits-changed` event set on its risk, and the ones it replaced. */
  readonly limits: {
    readonly quota: number;
    readonly quota_before: number;
    readonly rate_limit_max: number;
    readonly rate_limit_max_before: number;
    /** Present when the window moved too (an edit of the mission). */
    readonly rate_window_seconds?: number;
    readonly rate_window_seconds_before?: number;
  } | null;
  /**
   * The refs of the resources a `resources-created` event says the mission created and
   * reaches (ADR created-resources-join-the-mission); `tool` is the creating call.
   */
  readonly created_refs: readonly string[] | null;
  /** The limits and gate a `permission-added` event started with, or a `permission-removed` had. */
  readonly permission: {
    readonly quota: number;
    readonly rate_limit_max: number;
    readonly rate_window_seconds: number;
    readonly gate: Gate;
  } | null;
  /** The clauses of a `mission-changed` event: "2 resources added", "quota of x 2 → 5". */
  readonly mission_change: readonly string[] | null;
  /** Why a closed request closed when nobody answered it as such (`mission-changed`). */
  readonly request_reason: string | null;
  /** How many tokens a `revocation` retired. */
  readonly tokens_revoked: number | null;
  /** The token a `rotation` issued, or the one token a `revocation` retired. */
  readonly token_prefix: string | null;
  /** The token a `rotation` replaced; `null` for a holder's first token. */
  readonly replaced_prefix: string | null;
  /** Actions a granted claim gave back, per risk (`reset`, quota `extension`). */
  readonly credits: Readonly<Record<RiskId, number>> | null;
  /** What an `extension` extended: `quota` or `expiry`. */
  readonly dimension: string | null;
  /**
   * The mission's new expiry after an expiry `extension`; for an `approval`,
   * the instant before which the approved call must be replayed.
   */
  readonly expires_at: string | null;
}

export interface SessionOpenRequest {
  readonly id: string;
  readonly kind: RequestRecord['kind'];
  readonly risk_id: RiskId;
  readonly created_at: string;
  readonly expires_at: string;
  /**
   * Where the creator reads and answers it (`/waiting/<id>`); `null` for a
   * member, who sees that a request is waiting and cannot answer it.
   */
  readonly path: string | null;
  /** An approval request: the tool of the call, as the activity already shows it. `null` for a claim. */
  readonly tool: string | null;
  /**
   * An approval request: the resource the refused call resolved to, as its
   * audit entry holds it (`acme-org/app`). The same fact a reader of this view
   * finds on the entry in the activity; never the arguments or their fingerprint.
   */
  readonly resource_ref: string | null;
}

/** The calls of the current period under one label (`null`: no label). Not a budget. */
export interface SessionLabelActivity {
  readonly label: string | null;
  readonly allowed: number;
  readonly refused: number;
  readonly last_seen_at: string;
}

/**
 * The calls of the current period made with the tokens of one holder; `holder:
 * null` gathers the calls stored before tokens had a holder. Not a budget.
 */
export interface SessionHolderActivity {
  readonly holder: SessionHolderView | null;
  readonly allowed: number;
  readonly refused: number;
  readonly last_seen_at: string;
}

export interface MissionSessionView {
  readonly mission: { readonly id: string; readonly name: string };
  /** What the reader is to the mission; a member answers no request. */
  readonly viewer_role: MissionRole;
  readonly state: MissionState;
  /** `null` until the first call: the session is born with it (spec §3.3). */
  readonly session: { readonly id: string; readonly created_at: string } | null;
  readonly risks: readonly SessionRiskRow[];
  /** The current period first (when the mission is active), then the past ones. */
  readonly periods: readonly SessionPeriodRow[];
  /** Newest first. */
  readonly events: readonly SessionEventView[];
  readonly next_events: AuditCursor | null;
  /** The filter `events` was read with. */
  readonly timeline_filter: SessionTimelineFilter;
  readonly open_requests: readonly SessionOpenRequest[];
  /** Every label seen on the mission's calls still in the audit, most recent first. */
  readonly agent_labels: readonly AgentLabelSeen[];
  /**
   * Calls of the current period per label, busiest first; empty when the
   * mission is not active (it has no current period). Informational.
   */
  readonly label_activity: readonly SessionLabelActivity[];
  /**
   * Calls of the current period per token holder, busiest first; empty when the
   * mission is not active. Informational: one budget per mission, however many
   * tokens (spec §3.2).
   */
  readonly holder_activity: readonly SessionHolderActivity[];
}

export interface MissionSessionDeps {
  readonly store: Pick<Store, 'sessions' | 'requests' | 'audit' | 'users'>;
  readonly missions: Pick<MissionService, 'get'>;
  readonly clock: Clock;
}

export class MissionSessionService {
  constructor(private readonly deps: MissionSessionDeps) {}

  async get(
    user: Subject,
    missionId: string,
    options: {
      readonly eventsBefore?: AuditCursor | null;
      readonly timeline?: SessionTimelineFilter;
    } = {},
  ): Promise<MissionSessionView | null> {
    const detail = await this.deps.missions.get(user, missionId);
    if (!detail) return null;
    const { store } = this.deps;
    const session = await store.sessions.getByMission(missionId);
    const counters = session ? await store.sessions.counters(session.id) : [];
    const filter = options.timeline ?? ALL_EVENTS;
    const timeline: TimelinePage = session
      ? await this.timelinePage(session.id, filter, options.eventsBefore ?? null)
      : { shown: [], next: null };
    const now = this.deps.clock.now();
    const requests = await store.requests.listForMission(missionId);
    const period = detail.state.kind === 'active' ? detail.state.period : null;
    const activity = period
      ? await store.audit.agentLabelActivity(missionId, { since: period.start, until: period.end })
      : [];
    const byHolder = period
      ? await store.audit.tokenHolderActivity(missionId, { since: period.start, until: period.end })
      : [];
    const names = new HolderNames(store.users);
    const holderActivity: SessionHolderActivity[] = [];
    for (const row of byHolder) holderActivity.push(await holderActivityView(row, names));
    holderActivity.sort(byActivityThenLabel);
    const answers = detail.role === 'creator';

    return {
      mission: { id: detail.mission.id, name: detail.mission.name },
      viewer_role: detail.role,
      state: detail.state,
      session: session ? { id: session.id, created_at: session.createdAt } : null,
      risks: riskRows(detail, counters),
      periods: periodRows(detail, counters),
      events: await this.eventViews(timeline.shown, names),
      next_events: timeline.next,
      timeline_filter: filter,
      open_requests: await Promise.all(
        requests
          .filter((r) => isDecidable(r, now))
          .map(async (r) => ({
            id: r.id,
            kind: r.kind,
            risk_id: r.riskId,
            created_at: r.createdAt,
            expires_at: r.expiresAt,
            path: answers ? inboxRequestPath(r.id) : null,
            tool: r.kind === 'claim' ? null : r.tool,
            resource_ref:
              r.kind !== 'claim' && r.tool && r.fingerprint
                ? ((
                    await store.audit.latestCall({
                      missionId,
                      tool: r.tool,
                      argumentsHash: r.fingerprint,
                      refusalCode: 'approval-required',
                    })
                  )?.resource_ref ?? null)
                : null,
          })),
      ),
      agent_labels: await store.audit.agentLabels(missionId),
      label_activity: activity.map(labelActivityView),
      holder_activity: holderActivity,
    };
  }

  /** One page of the timeline, newest first, under `filter`. */
  private async timelinePage(
    sessionId: string,
    filter: SessionTimelineFilter,
    before: AuditCursor | null,
  ): Promise<TimelinePage> {
    // One more than the page: its presence says there is an older page.
    const page = await this.deps.store.sessions.listRecentEvents(sessionId, {
      limit: SESSION_EVENTS_PAGE_SIZE + 1,
      ...(before ? { before } : {}),
      ...callsOf(filter),
    });
    const shown = page.slice(0, SESSION_EVENTS_PAGE_SIZE);
    const last = shown.at(-1);
    return {
      shown,
      next: page.length > SESSION_EVENTS_PAGE_SIZE && last ? positionOf(last) : null,
    };
  }

  private async eventViews(
    events: readonly EventRecord[],
    names: HolderNames,
  ): Promise<SessionEventView[]> {
    const views: SessionEventView[] = [];
    for (const event of events) {
      const actorEmail = event.actorUserId ? await names.email(event.actorUserId) : null;
      const parsed = parseEventDetails(event.kind, event.details);
      const ref = holderRefOf(parsed);
      views.push(eventView(event, actorEmail, ref && (await names.view(ref))));
    }
    return views;
  }
}

/** The repository's `calls` option of a timeline filter. */
function callsOf(
  filter: SessionTimelineFilter,
): Pick<Parameters<Store['sessions']['listRecentEvents']>[1], 'calls'> {
  switch (filter.kind) {
    case 'all':
      return {};
    case 'label':
      return { calls: { agentLabel: filter.label } };
    case 'unlabelled':
      return { calls: { agentLabel: null } };
    case 'holder':
      return { calls: { holder: { kind: filter.holder.kind, holder: filter.holder.key } } };
  }
}

/** Emails behind the user ids of one view, read once each. */
class HolderNames {
  private readonly emails = new Map<string, string | null>();

  constructor(private readonly users: Pick<Store['users'], 'getById'>) {}

  async email(userId: string): Promise<string | null> {
    if (!this.emails.has(userId)) {
      this.emails.set(userId, (await this.users.getById(userId))?.email ?? null);
    }
    return this.emails.get(userId) ?? null;
  }

  /** A member is shown by their email (their id when the user row is gone); a named token by its name. */
  async view(ref: SessionHolderRef): Promise<SessionHolderView> {
    if (ref.kind === 'named') return { ...ref, label: ref.key };
    return { ...ref, label: (await this.email(ref.key)) ?? ref.key };
  }
}

/** The holder an event names, from its stored details. */
function holderRefOf(parsed: SessionEventDetails | null): SessionHolderRef | null {
  if (!parsed) return null;
  switch (parsed.kind) {
    case 'call-allowed':
    case 'call-refused':
    case 'rotation':
    case 'revocation': {
      const { token_kind: kind, holder } = parsed.details;
      return kind && holder ? { kind, key: holder } : null;
    }
    default:
      return null;
  }
}

/** Busiest first; then by the name a reader sees, the unattributed calls last. */
function byActivityThenLabel(a: SessionHolderActivity, b: SessionHolderActivity): number {
  const busier = b.allowed + b.refused - (a.allowed + a.refused);
  if (busier !== 0) return busier;
  if (a.holder === null || b.holder === null) return a.holder === null ? 1 : -1;
  return a.holder.label.localeCompare(b.holder.label);
}

async function holderActivityView(
  activity: TokenHolderActivity,
  names: HolderNames,
): Promise<SessionHolderActivity> {
  return {
    holder:
      activity.kind !== null && activity.holder !== null
        ? await names.view({ kind: activity.kind, key: activity.holder })
        : null,
    allowed: activity.allowed,
    refused: activity.refused,
    last_seen_at: activity.lastSeenAt,
  };
}

/** A page of timeline events and where the next (older) one starts. */
interface TimelinePage {
  readonly shown: readonly EventRecord[];
  readonly next: AuditCursor | null;
}

const positionOf = (event: EventRecord): AuditCursor => ({ ts: event.ts, id: event.id });

function labelActivityView(activity: AgentLabelActivity): SessionLabelActivity {
  return {
    label: activity.label,
    allowed: activity.allowed,
    refused: activity.refused,
    last_seen_at: activity.lastSeenAt,
  };
}

function riskRows(
  detail: MissionDetail,
  counters: readonly SessionCounterRecord[],
): SessionRiskRow[] {
  const { state } = detail;
  const active = state.kind === 'active' ? state : null;
  const consumed = new Map(
    counters
      .filter((c) => active !== null && c.periodStart === active.period.start)
      .map((c) => [c.riskId, c.consumed] as const),
  );
  return detail.policy.map((entry) => ({
    risk_id: entry.risk_id,
    quota: entry.quota,
    rate_limit: entry.rate_limit,
    gate: entry.gate,
    label: entry.label,
    level: entry.level,
    consumed: active ? (consumed.get(entry.risk_id) ?? 0) : null,
    remaining: active ? (active.remaining[entry.risk_id] ?? null) : null,
    exhausted: active ? active.exhausted.includes(entry.risk_id) : false,
    gate_open_until: entry.gate_open_until,
  }));
}

function periodRows(
  detail: MissionDetail,
  counters: readonly SessionCounterRecord[],
): SessionPeriodRow[] {
  const lengthSeconds = detail.mission.periodSeconds;
  const currentStart = detail.state.kind === 'active' ? detail.state.period.start : null;
  const byStart = new Map<string, Record<RiskId, number>>();
  // The current period is listed even before its first action.
  if (currentStart !== null) byStart.set(currentStart, {});
  for (const counter of counters) {
    const row = byStart.get(counter.periodStart) ?? {};
    row[counter.riskId] = counter.consumed;
    byStart.set(counter.periodStart, row);
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, PAST_PERIODS_SHOWN + 1)
    .map(([start, consumed]) => ({
      start,
      end:
        lengthSeconds === null
          ? null
          : new Date(Date.parse(start) + lengthSeconds * MS_PER_SECOND).toISOString(),
      current: start === currentStart,
      consumed,
    }));
}

/** The detail fields of an event view, all absent. */
const NO_DETAIL = {
  tool: null,
  refusal_code: null,
  agent_label: null,
  remaining: null,
  request_id: null,
  request_kind: null,
  request_state: null,
  approvals_consumed: 0,
  gate: null,
  gate_before: null,
  gate_open_until: null,
  limits: null,
  created_refs: null,
  permission: null,
  mission_change: null,
  request_reason: null,
  tokens_revoked: null,
  token_prefix: null,
  replaced_prefix: null,
  credits: null,
  dimension: null,
  expires_at: null,
} satisfies Partial<SessionEventView>;

type EventDetailFields = Pick<SessionEventView, keyof typeof NO_DETAIL>;

/** `null` for a table with no entry: the page shows nothing rather than an empty list. */
function countsOrNull(counts: Readonly<Record<RiskId, number>>): Record<RiskId, number> | null {
  return Object.keys(counts).length > 0 ? { ...counts } : null;
}

function detailFields(parsed: SessionEventDetails | null): EventDetailFields {
  if (!parsed) return NO_DETAIL;
  switch (parsed.kind) {
    case 'call-allowed':
      return {
        ...NO_DETAIL,
        tool: parsed.details.tool || null,
        agent_label: parsed.details.agent_label || null,
        remaining: countsOrNull(parsed.details.remaining),
        approvals_consumed: parsed.details.approval_ids.length,
      };
    case 'call-refused':
      return {
        ...NO_DETAIL,
        tool: parsed.details.tool || null,
        agent_label: parsed.details.agent_label || null,
        refusal_code: parsed.details.refusal_code,
        request_id: parsed.details.request_id,
        request_kind: parsed.details.request_id
          ? requestKindOfRefusal(parsed.details.refusal_code)
          : null,
      };
    case 'request':
      return {
        ...NO_DETAIL,
        request_id: parsed.details.request_id,
        request_kind: parsed.details.request_kind,
        request_state: 'state' in parsed.details ? parsed.details.state : null,
        request_reason: 'state' in parsed.details ? (parsed.details.reason ?? null) : null,
        tool: 'tool' in parsed.details ? parsed.details.tool || null : null,
      };
    case 'reset':
      return {
        ...NO_DETAIL,
        request_id: parsed.details.request_id,
        credits: countsOrNull(parsed.details.credits),
      };
    case 'extension':
      return parsed.details.dimension === 'quota'
        ? {
            ...NO_DETAIL,
            request_id: parsed.details.request_id,
            dimension: parsed.details.dimension,
            credits: countsOrNull(parsed.details.credits),
          }
        : {
            ...NO_DETAIL,
            request_id: parsed.details.request_id,
            dimension: parsed.details.dimension,
            expires_at: parsed.details.expires_at,
          };
    case 'approval':
      return {
        ...NO_DETAIL,
        request_id: parsed.details.request_id,
        request_kind: 'approval',
        tool: parsed.details.tool || null,
        expires_at: parsed.details.expires_at,
      };
    case 'gate-opened':
      return {
        ...NO_DETAIL,
        request_id: parsed.details.request_id,
        request_kind: 'approval',
        gate_open_until: parsed.details.period_end,
      };
    case 'gate-changed':
      return {
        ...NO_DETAIL,
        gate: parsed.details.gate,
        gate_before: parsed.details.gate_before,
      };
    case 'limits-changed':
      return { ...NO_DETAIL, limits: { ...parsed.details } };
    case 'resources-created':
      return {
        ...NO_DETAIL,
        tool: parsed.details.tool || null,
        created_refs: [...parsed.details.refs],
      };
    case 'permission-added':
    case 'permission-removed':
      return { ...NO_DETAIL, permission: { ...parsed.details } };
    case 'mission-changed':
      return { ...NO_DETAIL, mission_change: missionChangeClauses(parsed.details) };
    case 'rotation':
      return {
        ...NO_DETAIL,
        token_prefix: parsed.details.token_prefix,
        replaced_prefix: parsed.details.replaced_prefix ?? null,
      };
    case 'revocation':
      return {
        ...NO_DETAIL,
        tokens_revoked: parsed.details.tokens_revoked,
        token_prefix: parsed.details.token_prefix ?? null,
      };
  }
}

/**
 * The kind of request a refused call points to. The budget drops a claim on
 * `budget-exhausted` and an approval request on `approval-required`
 * (`SessionService.requestFor`, `server/budget`); no other refusal carries a request.
 */
function requestKindOfRefusal(code: string): RequestKind | null {
  if (code === 'budget-exhausted') return 'claim';
  if (code === 'approval-required') return 'approval';
  return null;
}

/** The risk of the event's own column, then those a call event lists. */
function riskIdsOf(event: EventRecord, parsed: SessionEventDetails | null): RiskId[] {
  const ids =
    parsed && (parsed.kind === 'call-allowed' || parsed.kind === 'call-refused')
      ? [...parsed.details.risk_ids]
      : [];
  if (event.riskId && !ids.includes(event.riskId)) ids.unshift(event.riskId);
  return ids;
}

/**
 * The fields of an event the page shows; the rest of `details` is not surfaced.
 * `holder` is the event's token holder with its label resolved by the caller
 * (`null`: the event names none).
 */
export function eventView(
  event: EventRecord,
  actorEmail: string | null,
  holder: SessionHolderView | null = null,
): SessionEventView {
  const parsed = parseEventDetails(event.kind, event.details);
  return {
    id: event.id,
    ts: event.ts,
    kind: event.kind,
    risk_ids: riskIdsOf(event, parsed),
    actor_email: actorEmail,
    holder,
    ...detailFields(parsed),
  };
}
