/**
 * `MissionSessionService` — what the Mission session page reads (spec §4.2
 * "Mission session — event timeline, counters per risk and per period, gate
 * per risk, open requests"; §3.3 the session and the remaining budget).
 *
 * Read-only. The mission's creator only: "does not exist" and "not yours" are
 * the same answer, as on the mission detail page. Open requests are listed by
 * link to the creator's view of the request (`/requests/<id>`, P1.7): their
 * arguments stay there. An event shows the fields named below and nothing
 * else of its details, read through `parseEventDetails` (`@vaubaan/shared`):
 * an event whose stored details do not have the shape of its kind is listed
 * with its kind, time, risk and actor, and no detail.
 *
 * The counters are the store's, as they stand: a granted claim (period reset,
 * quota extension) lowers them, so "counted" can go down during a period. The
 * `reset` / `extension` events of the timeline say how much was given back.
 */
import {
  parseEventDetails,
  type MissionPolicyEntry,
  type RiskId,
  type SessionEventDetails,
} from '@vaubaan/shared';

import type { AuthoritySubject } from '../authority';
import type { MissionState } from '../budget';
import type { MissionDetail, MissionService, SeverityLevel } from '../missions';
import { isDecidable } from '../requests/state';
import { inboxRequestPath } from '../requests/url';
import type { AgentLabelSeen, AuditCursor, Store } from '../store';
import type { Clock } from '../store/clock';
import type { EventRecord, RequestRecord, SessionCounterRecord } from '../store/types';

export const SESSION_EVENTS_PAGE_SIZE = 100;
/** How many past periods the counters table shows, newest first. */
export const PAST_PERIODS_SHOWN = 7;

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
  /** Remaining quota per touched risk after an allowed call. */
  readonly remaining: Readonly<Record<RiskId, number>> | null;
  readonly request_id: string | null;
  readonly request_kind: string | null;
  readonly token_prefix: string | null;
  /** Actions a granted claim gave back, per risk (`reset`, quota `extension`). */
  readonly credits: Readonly<Record<RiskId, number>> | null;
  /** What an `extension` extended: `quota` or `expiry`. */
  readonly dimension: string | null;
  /** The mission's new expiry after an expiry `extension`. */
  readonly expires_at: string | null;
}

export interface SessionOpenRequest {
  readonly id: string;
  readonly kind: RequestRecord['kind'];
  readonly risk_id: RiskId;
  readonly created_at: string;
  readonly expires_at: string;
  /** Where the creator reads and answers it (`/requests/<id>`). */
  readonly path: string;
}

export interface MissionSessionView {
  readonly mission: { readonly id: string; readonly name: string };
  readonly state: MissionState;
  /** `null` until the first call: the session is born with it (spec §3.3). */
  readonly session: { readonly id: string; readonly created_at: string } | null;
  readonly risks: readonly SessionRiskRow[];
  /** The current period first (when the mission is active), then the past ones. */
  readonly periods: readonly SessionPeriodRow[];
  /** Newest first. */
  readonly events: readonly SessionEventView[];
  readonly next_events: AuditCursor | null;
  readonly open_requests: readonly SessionOpenRequest[];
  readonly agent_labels: readonly AgentLabelSeen[];
}

export interface MissionSessionDeps {
  readonly store: Pick<Store, 'sessions' | 'requests' | 'audit' | 'users'>;
  readonly missions: Pick<MissionService, 'get'>;
  readonly clock: Clock;
}

export class MissionSessionService {
  constructor(private readonly deps: MissionSessionDeps) {}

  async get(
    user: AuthoritySubject,
    missionId: string,
    options: { readonly eventsBefore?: AuditCursor | null } = {},
  ): Promise<MissionSessionView | null> {
    const detail = await this.deps.missions.get(user, missionId);
    if (!detail) return null;
    const { store } = this.deps;
    const session = await store.sessions.getByMission(missionId);
    const counters = session ? await store.sessions.counters(session.id) : [];
    const page = session
      ? await store.sessions.listRecentEvents(session.id, {
          limit: SESSION_EVENTS_PAGE_SIZE + 1,
          ...(options.eventsBefore ? { before: options.eventsBefore } : {}),
        })
      : [];
    const shown = page.slice(0, SESSION_EVENTS_PAGE_SIZE);
    const last = shown.at(-1);
    const now = this.deps.clock.now();
    const requests = await store.requests.listForMission(missionId);

    return {
      mission: { id: detail.mission.id, name: detail.mission.name },
      state: detail.state,
      session: session ? { id: session.id, created_at: session.createdAt } : null,
      risks: riskRows(detail, counters),
      periods: periodRows(detail, counters),
      events: await this.eventViews(shown),
      next_events:
        page.length > SESSION_EVENTS_PAGE_SIZE && last ? { ts: last.ts, id: last.id } : null,
      open_requests: requests
        .filter((r) => isDecidable(r, now))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          risk_id: r.riskId,
          created_at: r.createdAt,
          expires_at: r.expiresAt,
          path: inboxRequestPath(r.id),
        })),
      agent_labels: await store.audit.agentLabels(missionId),
    };
  }

  private async eventViews(events: readonly EventRecord[]): Promise<SessionEventView[]> {
    const emails = new Map<string, string | null>();
    const views: SessionEventView[] = [];
    for (const event of events) {
      let actorEmail: string | null = null;
      if (event.actorUserId) {
        if (!emails.has(event.actorUserId)) {
          const user = await this.deps.store.users.getById(event.actorUserId);
          emails.set(event.actorUserId, user?.email ?? null);
        }
        actorEmail = emails.get(event.actorUserId) ?? null;
      }
      views.push(eventView(event, actorEmail));
    }
    return views;
  }
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
  token_prefix: null,
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
      };
    case 'call-refused':
      return {
        ...NO_DETAIL,
        tool: parsed.details.tool || null,
        agent_label: parsed.details.agent_label || null,
        refusal_code: parsed.details.refusal_code,
        request_id: parsed.details.request_id,
      };
    case 'request':
      return {
        ...NO_DETAIL,
        request_id: parsed.details.request_id,
        request_kind: parsed.details.request_kind,
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
    case 'rotation':
      return { ...NO_DETAIL, token_prefix: parsed.details.token_prefix };
    case 'revocation':
      return NO_DETAIL;
  }
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

/** The fields of an event the page shows; the rest of `details` is not surfaced. */
export function eventView(event: EventRecord, actorEmail: string | null): SessionEventView {
  const parsed = parseEventDetails(event.kind, event.details);
  return {
    id: event.id,
    ts: event.ts,
    kind: event.kind,
    risk_ids: riskIdsOf(event, parsed),
    actor_email: actorEmail,
    ...detailFields(parsed),
  };
}
