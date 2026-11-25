/**
 * `ActivityTimelineService` — what the Activity's Timeline reads (spec §4.2
 * "Activity"): the mission log events of every mission the viewer may read,
 * newest first, in pages, filtered by mission, key holder and agent label.
 * The same events, worded by the same `eventWords`, as the activity of one
 * mission used to list on its own page.
 *
 * Who reads what: the mission logs of the missions the viewer created or is a
 * current member of, and every mission log for an operator — scoped in SQL before
 * the filters and the keyset (`MissionLogsRepo.searchEvents`), so a filter only
 * narrows. The owner of an account reads the calls through it in the Record,
 * not the mission logs of the missions that carry it: a mission log mixes every
 * account of its mission and its budget, and an owner reads "only this
 * account's part" of a mission (spec §4.2 "Accounts"). The bootstrap operator
 * reads no call, so no mission log.
 *
 * An event shows what `eventView` exposes and nothing else of its details;
 * arguments are never stored in an event, and their fingerprint is never
 * surfaced. A waiting request is linked to the page that answers it for the
 * mission's creator only, as on the mission's own page.
 */
import { isDecidable } from '../requests/state';
import { inboxRequestPath } from '../requests/url';
import type { AuditCursor, EventSearch, MissionEventRecord, Store } from '../store';
import type { Clock } from '../store/clock';
import { keysetOf, pageOf, type PagePosition } from './paging';
import { holdersOf, type AuditViewer } from './query-service';
import {
  eventView,
  HolderNames,
  holderRefOfEvent,
  type MissionLogEventView,
} from './mission-log-view';

export const TIMELINE_PAGE_SIZE = 50;

export const TIMELINE_PARAMS = {
  mission: 'mission',
  holder: 'holder',
  agent: 'agent',
  unlabelled: 'unlabelled',
} as const;

type TimelineParam = keyof typeof TIMELINE_PARAMS;

export interface TimelineFilters {
  readonly missionId: string | null;
  /**
   * The key holder, as typed: a member's email, the name of a machine key, or
   * the exact form `member:<user id>` / `named:<name>` (as the Record reads it).
   */
  readonly holder: string | null;
  /** Exact agent label, as declared by the caller. */
  readonly agentLabel: string | null;
  /** The calls that carried no label. Ignored with `agentLabel`. */
  readonly unlabelled: boolean;
}

export const NO_TIMELINE_FILTER: TimelineFilters = {
  missionId: null,
  holder: null,
  agentLabel: null,
  unlabelled: false,
};

export interface ParsedTimelineQuery {
  readonly filters: TimelineFilters;
  /** The raw values, for re-filling the form and building the pager's links. */
  readonly raw: Readonly<Partial<Record<TimelineParam, string>>>;
  readonly problems: readonly string[];
}

const MAX_VALUE_LENGTH = 200;

/** The Timeline's filters from the address. A value that cannot be read is dropped and reported. */
export function parseTimelineQuery(
  query: Readonly<Record<string, string | readonly string[] | undefined>>,
): ParsedTimelineQuery {
  const problems: string[] = [];
  const raw: Partial<Record<TimelineParam, string>> = {};
  const read = (param: TimelineParam): string | null => {
    const value = query[TIMELINE_PARAMS[param]];
    const text = Array.isArray(value) ? (value as readonly string[])[0] : value;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    const trimmed = text.trim();
    if (trimmed.length > MAX_VALUE_LENGTH) {
      problems.push(`${TIMELINE_PARAMS[param]}: value too long, ignored`);
      return null;
    }
    raw[param] = trimmed;
    return trimmed;
  };
  const missionId = read('mission');
  const holder = read('holder');
  const agentLabel = read('agent');
  const unlabelledRaw = read('unlabelled');
  const unlabelled = unlabelledRaw === '1' && agentLabel === null;
  if (unlabelledRaw !== null && !unlabelled) delete raw.unlabelled;
  return { filters: { missionId, holder, agentLabel, unlabelled }, raw, problems };
}

/** The query string of the same filters, on their first page. */
export function timelineQueryString(raw: ParsedTimelineQuery['raw']): string {
  const params = new URLSearchParams();
  for (const param of Object.keys(TIMELINE_PARAMS) as TimelineParam[]) {
    const value = raw[param];
    if (value) params.set(TIMELINE_PARAMS[param], value);
  }
  return params.toString();
}

/** The mission an event belongs to, as the Timeline shows it. */
export interface TimelineMissionRef {
  readonly id: string;
  /** `null` when the mission no longer exists. */
  readonly name: string | null;
}

export interface TimelineEventView extends MissionLogEventView {
  readonly mission: TimelineMissionRef;
}

/** A request of a page's events that still waits for its answer. */
export interface TimelineOpenRequest {
  readonly id: string;
  /** Where the creator answers it; `null` for anyone else. */
  readonly path: string | null;
  /** Whose answer it waits for, for anyone but the creator (`null` for the creator). */
  readonly creator: string | null;
}

export interface TimelinePage {
  /** Newest first. */
  readonly events: readonly TimelineEventView[];
  readonly older: AuditCursor | null;
  readonly newer: AuditCursor | null;
  readonly open_requests: readonly TimelineOpenRequest[];
}

export interface ActivityTimelineDeps {
  readonly store: Pick<Store, 'missionLogs' | 'missions' | 'requests' | 'users'>;
  readonly clock: Clock;
}

export class ActivityTimelineService {
  constructor(private readonly deps: ActivityTimelineDeps) {}

  async search(
    viewer: AuditViewer,
    filters: TimelineFilters,
    position: PagePosition | null = null,
    pageSize: number = TIMELINE_PAGE_SIZE,
  ): Promise<TimelinePage> {
    const { store } = this.deps;
    const calls = await this.callsOf(filters);
    // One more than the page: its presence says there is a further page that way.
    const rows = await store.missionLogs.searchEvents({
      scope: eventScopeOf(viewer),
      limit: pageSize + 1,
      ...(filters.missionId ? { missionId: filters.missionId } : {}),
      ...(calls ? { calls } : {}),
      ...keysetOf(position),
    });
    const { shown, older, newer } = pageOf(rows, pageSize, position);
    const names = new HolderNames(store.users);
    const missions = new Map<string, Promise<MissionFacts>>();
    const factsOf = (id: string): Promise<MissionFacts> => {
      let facts = missions.get(id);
      if (!facts) {
        facts = this.missionFacts(id, viewer, names);
        missions.set(id, facts);
      }
      return facts;
    };
    const events: TimelineEventView[] = [];
    for (const row of shown) events.push(await this.view(row, names, await factsOf(row.missionId)));
    const open: TimelineOpenRequest[] = [];
    const now = this.deps.clock.now();
    for (const [id, facts] of missions) {
      const { creatorIsViewer, creator } = await facts;
      for (const request of await store.requests.listForMission(id)) {
        if (!isDecidable(request, now)) continue;
        if (!events.some((event) => event.request_id === request.id)) continue;
        open.push({
          id: request.id,
          path: creatorIsViewer ? inboxRequestPath(request.id) : null,
          creator: creatorIsViewer ? null : creator,
        });
      }
    }
    return { events, older, newer, open_requests: open };
  }

  /** The repository's `calls` option of the filters; `undefined`: every event, calls or not. */
  private async callsOf(filters: TimelineFilters): Promise<EventSearch['calls']> {
    const agentLabel = filters.agentLabel ?? (filters.unlabelled ? null : undefined);
    const holders =
      filters.holder === null ? undefined : await holdersOf(this.deps.store.users, filters.holder);
    if (agentLabel === undefined && holders === undefined) return undefined;
    return {
      ...(agentLabel !== undefined ? { agentLabel } : {}),
      ...(holders ? { holders } : {}),
    };
  }

  private async missionFacts(
    id: string,
    viewer: AuditViewer,
    names: HolderNames,
  ): Promise<MissionFacts> {
    const mission = await this.deps.store.missions.getById(id);
    if (!mission)
      return { ref: { id, name: null }, creatorIsViewer: false, creator: 'the creator' };
    const creatorIsViewer = viewer.kind === 'user' && viewer.user.id === mission.creatorUserId;
    return {
      ref: { id, name: mission.name },
      creatorIsViewer,
      creator: (await names.email(mission.creatorUserId)) ?? 'the creator',
    };
  }

  private async view(
    row: MissionEventRecord,
    names: HolderNames,
    facts: MissionFacts,
  ): Promise<TimelineEventView> {
    const actorEmail = row.actorUserId ? await names.email(row.actorUserId) : null;
    const ref = holderRefOfEvent(row);
    return {
      ...eventView(row, actorEmail, ref && (await names.view(ref))),
      mission: facts.ref,
    };
  }
}

interface MissionFacts {
  readonly ref: TimelineMissionRef;
  readonly creatorIsViewer: boolean;
  /** The creator's email, as a teammate reads "waiting for …". */
  readonly creator: string;
}

/** The mission logs a viewer reads: those of the missions they created or are a member of; all for an operator. */
export function eventScopeOf(viewer: AuditViewer): EventSearch['scope'] {
  if (viewer.kind === 'bootstrap') {
    return { missionCreatorUserId: null, missionMemberUserId: null, allMissions: false };
  }
  return {
    missionCreatorUserId: viewer.user.id,
    missionMemberUserId: viewer.user.id,
    allMissions: viewer.isOperator,
  };
}
