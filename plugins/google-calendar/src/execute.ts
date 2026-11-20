/**
 * Upstream calls of the `google-calendar` service — Google's Calendar REST
 * API v3 — and resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/services/google-calendar.md.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md.
 *
 * Rules:
 *   - the call is read by `readCalendarCall`, the classifier's own reader:
 *     what is sent is built from the arguments it returned, never `args`;
 *   - `list_calendars` is answered from the mission's calendars;
 *   - every other tool is one to two requests to the REST API through the
 *     SDK's `httpJson`, with the access token the broker issued (401 / 403
 *     `UpstreamAuthError`, another status `UpstreamHttpError`, an answer that
 *     is not JSON or not the shape a guard reads `UpstreamProtocolError`);
 *     Google's answer is passed through as JSON;
 *   - every path segment is a value of its grammar, checked again by
 *     `pathSegment` and percent-encoded;
 *   - `update_event` with attendees to add or remove and `respond_to_event`
 *     read the event first, then patch it;
 *   - what Google answers is untrusted: discovery reads calendar ids through
 *     their grammar and keeps only what it recognises as a calendar.
 */

import {
  type AccountContext,
  anyJson,
  CredentialRefusal,
  declining,
  type ExecuteContext,
  ExecutorRefusal,
  expectCredentialKind,
  type Guard,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  type McpToolResult,
  queryString,
  type Resource,
  UpstreamAuthError,
  UpstreamHttpError,
} from '@vaubaan/plugin-sdk';

import { instantOf, readCalendarCall, type CalendarCall } from './call.ts';
import { missingScopes, scopesNotGrantedMessage } from './credential.ts';
import { freeSlots, type Span } from './free-slots.ts';
import { calendarIdOf, calendarRefOf, parseAddress, pathSegment } from './identifiers.ts';
import { BARE_TOOL, CALENDAR_API_BASE, PRIMARY_KEYWORD, SERVICE_ID } from './identity.ts';

/** Discovery keeps at most this many calendars. */
export const MAX_DISCOVERED_CALENDARS = 250;
/** The largest page calendarList.list gives (Google's reference: max 250). */
export const DISCOVERY_PAGE_SIZE = 250;
/** At most this many pages are asked for. */
const MAX_DISCOVERY_PAGES = 5;
/** Events per page when the agent does not say. */
export const DEFAULT_EVENTS_PER_PAGE = 50;
/** `suggest_time` defaults. */
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_SUGGESTIONS = 10;

/** Mail domains that are not a company's: their account's own domain is not taken as internal. */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * What a person reads when Google answers 403 to the calendar list of an
 * account that has just authorized it (a `CredentialRefusal`, shown on the
 * account page), the scopes granted.
 */
export const CALENDAR_API_REFUSED =
  "Google refused the Calendar API to this account. A Google Workspace administrator may have to allow the app for the organisation, or the broker's Google Cloud project may not have the Calendar API enabled; then refresh the account's calendars.";

/**
 * Google's reasons of a 403 that are a limit or a rule of the request, not
 * a refused credential (guide "Handle API errors"): the call is retried
 * later or changed, the account is not reconnected.
 */
const NOT_A_CREDENTIAL_403: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'forbiddenForNonOrganizer',
]);

type Args = Readonly<Record<string, unknown>>;
type Forward = Extract<CalendarCall, { kind: 'forward' }>;
type Query = Readonly<Record<string, string | number | boolean | undefined>>;

function tokenOf(ctx: AccountContext): string {
  return expectCredentialKind(SERVICE_ID, ctx.credential, 'oauth2').accessToken;
}

/** Refuses, before any request, a token Google issued with fewer scopes than asked. */
function expectRequiredScopes(ctx: AccountContext): void {
  const { scopes } = expectCredentialKind(SERVICE_ID, ctx.credential, 'oauth2');
  const missing = missingScopes(scopes);
  if (missing.length > 0) throw new CredentialRefusal(scopesNotGrantedMessage(missing), 403);
}

/** Google's `error.errors[0].reason` in the quoted start of a failed answer, if it is there. */
export function googleErrorReason(failure: Error): string | null {
  return /"reason"\s*:\s*"([A-Za-z]+)"/.exec(failure.message)?.[1] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

/** One request to the Calendar API; an answer without content (a deletion) is `null`. */
async function request<T = unknown>(
  ctx: AccountContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { readonly query?: Query; readonly body?: unknown; readonly guard?: Guard<T> } = {},
): Promise<T | null> {
  const guard = (options.guard ?? anyJson) as Guard<T>;
  return httpJson(
    ctx,
    {
      url: `${CALENDAR_API_BASE}${path}${queryString(options.query ?? {})}`,
      method,
      headers: { authorization: `Bearer ${tokenOf(ctx)}` },
      what: `Google Calendar API ${method} ${path}`,
      ...(options.body !== undefined ? { body: options.body } : {}),
    },
    (value): value is T | null => value === null || guard(value),
  );
}

function segmentOf(value: unknown, what: string): string {
  const segment = typeof value === 'string' ? pathSegment(value) : null;
  if (segment === null) throw new ExecutorRefusal(`${what}: not a path segment.`);
  return segment;
}

function eventsPath(call: Forward): string {
  return `/calendars/${segmentOf(call.arguments.calendarId, 'calendarId')}/events`;
}

function eventPath(call: Forward): string {
  return `${eventsPath(call)}/${segmentOf(call.arguments.eventId, 'eventId')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

export function executeGoogleCalendar(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  return declining(async () => {
    const read = readCalendarCall(tool, args, ctx.resources);
    if ('denied' in read) throw new ExecutorRefusal(read.denied);
    const { call } = read;
    if (call.kind === 'list-calendars') return listCalendarsResult(call.calendars);
    return jsonResult(await dispatch(ctx, call));
  });
}

async function dispatch(ctx: ExecuteContext, call: Forward): Promise<unknown> {
  const a = call.arguments;
  switch (call.bare) {
    case BARE_TOOL.listEvents: {
      const singleEvents = a.singleEvents !== false;
      return request(ctx, 'GET', eventsPath(call), {
        query: {
          timeMin: str(a.timeMin),
          timeMax: str(a.timeMax),
          q: str(a.q),
          singleEvents,
          orderBy: str(a.orderBy) ?? (singleEvents ? 'startTime' : undefined),
          maxResults: num(a.maxResults) ?? DEFAULT_EVENTS_PER_PAGE,
          pageToken: str(a.pageToken),
          timeZone: str(a.timeZone),
        },
      });
    }
    case BARE_TOOL.searchEvents:
      return request(ctx, 'GET', eventsPath(call), {
        query: {
          q: str(a.q),
          timeMin: str(a.timeMin),
          timeMax: str(a.timeMax),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: num(a.maxResults) ?? DEFAULT_EVENTS_PER_PAGE,
          pageToken: str(a.pageToken),
          timeZone: str(a.timeZone),
        },
      });
    case BARE_TOOL.getEvent:
      return request(ctx, 'GET', eventPath(call), { query: { timeZone: str(a.timeZone) } });
    case BARE_TOOL.suggestTime:
      return suggestTime(ctx, a);
    case BARE_TOOL.createEvent: {
      const meet = a.addGoogleMeet === true;
      return request(ctx, 'POST', eventsPath(call), {
        query: { sendUpdates: str(a.sendUpdates), conferenceDataVersion: meet ? 1 : undefined },
        body: {
          ...eventBody(a, false),
          ...(Array.isArray(a.attendees) ? { attendees: a.attendees } : {}),
          ...(meet ? meetRequest() : {}),
        },
      });
    }
    case BARE_TOOL.updateEvent:
      return updateEvent(ctx, call);
    case BARE_TOOL.deleteEvent: {
      const answer = await request(ctx, 'DELETE', eventPath(call), {
        query: { sendUpdates: str(a.sendUpdates) },
      });
      return answer ?? { deleted: true, eventId: a.eventId };
    }
    case BARE_TOOL.respondToEvent:
      return respondToEvent(ctx, call);
    default:
      throw new ExecutorRefusal(`unknown tool '${call.tool}'`);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** A start or an end of the events resource. On a patch the other form is cleared. */
function when(value: string, allDay: boolean, timeZone: string | undefined, patch: boolean) {
  if (allDay) return { date: value, ...(patch ? { dateTime: null, timeZone: null } : {}) };
  return { dateTime: value, ...(timeZone ? { timeZone } : {}), ...(patch ? { date: null } : {}) };
}

/** The fields of the events resource an agent's arguments set (attendees apart). */
function eventBody(a: Args, patch: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const name of [
    'summary',
    'description',
    'location',
    'visibility',
    'transparency',
    'colorId',
    'recurrence',
  ]) {
    if (a[name] !== undefined) body[name] = a[name];
  }
  const start = str(a.startTime);
  const end = str(a.endTime);
  if (start !== undefined && end !== undefined) {
    const allDay = a.allDay === true;
    body.start = when(start, allDay, str(a.timeZone), patch);
    body.end = when(end, allDay, str(a.timeZone), patch);
  }
  return body;
}

/** A new Google Meet conference (events resource `conferenceData.createRequest`). */
function meetRequest(): Record<string, unknown> {
  return {
    conferenceData: {
      createRequest: {
        requestId: globalThis.crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };
}

// ─── The event as the executor reads it back ─────────────────────────────────

/** An attendee of an event, as Google answers it. */
interface AttendeeOfEvent {
  readonly email: string;
  readonly self?: boolean;
  readonly [field: string]: unknown;
}

interface EventOfCalendar {
  readonly attendees?: readonly AttendeeOfEvent[];
  readonly attendeesOmitted?: boolean;
}

function isAttendee(x: unknown): x is AttendeeOfEvent {
  return (
    isRecord(x) &&
    typeof x.email === 'string' &&
    (x.self === undefined || typeof x.self === 'boolean')
  );
}

function isEvent(x: unknown): x is EventOfCalendar {
  return (
    isRecord(x) &&
    (x.attendees === undefined || (isList(x.attendees) && x.attendees.every(isAttendee))) &&
    (x.attendeesOmitted === undefined || typeof x.attendeesOmitted === 'boolean')
  );
}

/** The writable fields of an attendee Google answered (events resource). */
const WRITABLE_ATTENDEE_FIELDS = [
  'email',
  'displayName',
  'optional',
  'resource',
  'responseStatus',
  'comment',
  'additionalGuests',
] as const;

function writableAttendee(attendee: AttendeeOfEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of WRITABLE_ATTENDEE_FIELDS) {
    if (attendee[field] !== undefined) out[field] = attendee[field];
  }
  return out;
}

async function readEvent(
  ctx: AccountContext,
  call: Forward,
  query: Query = {},
): Promise<EventOfCalendar> {
  const event = await request(ctx, 'GET', eventPath(call), { query, guard: isEvent });
  if (event === null) throw new ExecutorRefusal('the event could not be read.');
  return event;
}

/**
 * The attendees after an update: the event's current guests, less the
 * removed addresses, plus the added people not already there. Google
 * replaces the whole list on a patch, so the current one is read first.
 */
export function mergedAttendees(
  current: readonly AttendeeOfEvent[],
  added: readonly Record<string, unknown>[],
  removed: readonly string[],
): Record<string, unknown>[] {
  const gone = new Set(removed);
  const kept = current
    .filter((a) => !gone.has(a.email.toLowerCase()))
    .map((a) => writableAttendee(a));
  const present = new Set(kept.map((a) => String(a.email).toLowerCase()));
  const fresh = added.filter((a) => !present.has(String(a.email)));
  return [...kept, ...fresh];
}

async function updateEvent(ctx: ExecuteContext, call: Forward): Promise<unknown> {
  const a = call.arguments;
  const added = Array.isArray(a.addedAttendees)
    ? (a.addedAttendees as Record<string, unknown>[])
    : [];
  const removed = Array.isArray(a.removedAttendeeEmails)
    ? (a.removedAttendeeEmails as string[])
    : [];
  const body = eventBody(a, true);
  if (added.length > 0 || removed.length > 0) {
    const event = await readEvent(ctx, call);
    if (event.attendeesOmitted === true) {
      throw new ExecutorRefusal(
        'Google did not give the full guest list of this event, so guests cannot be added or removed here.',
      );
    }
    body.attendees = mergedAttendees(event.attendees ?? [], added, removed);
  }
  const meet = a.addGoogleMeet === true;
  if (meet) Object.assign(body, meetRequest());
  return request(ctx, 'PATCH', eventPath(call), {
    query: { sendUpdates: str(a.sendUpdates), conferenceDataVersion: meet ? 1 : undefined },
    body,
  });
}

/**
 * The answer of this account: the event is read with `maxAttendees=1`
 * (Google then gives only this account's entry when there are more guests),
 * the entry marked `self` is found, and the event is patched with
 * `attendeesOmitted: true` and that entry alone, its `responseStatus` (and
 * comment) changed — Google's way to change only the participant's answer.
 */
async function respondToEvent(ctx: ExecuteContext, call: Forward): Promise<unknown> {
  const a = call.arguments;
  const event = await readEvent(ctx, call, { maxAttendees: 1 });
  const self = (event.attendees ?? []).find((attendee) => attendee.self === true);
  if (self === undefined) {
    throw new ExecutorRefusal(
      'this account is not a guest of the event: there is no invitation to answer.',
    );
  }
  return request(ctx, 'PATCH', eventPath(call), {
    query: { sendUpdates: str(a.sendUpdates) },
    body: {
      attendeesOmitted: true,
      attendees: [
        {
          email: self.email,
          responseStatus: a.responseStatus,
          ...(typeof a.responseComment === 'string' ? { comment: a.responseComment } : {}),
        },
      ],
    },
  });
}

// ─── suggest_time ─────────────────────────────────────────────────────────────

interface FreeBusyAnswer {
  readonly calendars?: Readonly<Record<string, unknown>>;
}

function isFreeBusyAnswer(x: unknown): x is FreeBusyAnswer {
  return isRecord(x) && (x.calendars === undefined || isRecord(x.calendars));
}

/** The busy spans of one entry of `calendars`, or `null` when Google reports an error for it. */
function busyOf(entry: unknown): Span[] | null {
  if (!isRecord(entry)) return null;
  if (isList(entry.errors) && entry.errors.length > 0) return null;
  if (!isList(entry.busy)) return [];
  const spans: Span[] = [];
  for (const block of entry.busy) {
    if (!isRecord(block)) return null;
    const start = instantOf(block.start);
    const end = instantOf(block.end);
    if (start === null || end === null) return null;
    spans.push({ start, end });
  }
  return spans;
}

/** The account's own calendar for free/busy: its address when discovery recorded it. */
function selfOf(resources: readonly Resource[]): string {
  for (const r of resources) {
    if (r.service === SERVICE_ID && typeof r.metadata?.account_email === 'string') {
      return r.metadata.account_email;
    }
  }
  return PRIMARY_KEYWORD;
}

async function suggestTime(ctx: ExecuteContext, a: Args): Promise<unknown> {
  const people = Array.isArray(a.attendeeEmails) ? (a.attendeeEmails as string[]) : [];
  const self = selfOf(ctx.resources);
  const ids = [self, ...people.filter((p) => p !== self)];
  const answer = await request(ctx, 'POST', '/freeBusy', {
    body: { timeMin: a.timeMin, timeMax: a.timeMax, items: ids.map((id) => ({ id })) },
    guard: isFreeBusyAnswer,
  });
  const calendars = answer?.calendars ?? {};
  const busy: Span[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const spans = busyOf(calendars[id]);
    if (spans === null) unknown.push(id === PRIMARY_KEYWORD ? 'this account' : id);
    else busy.push(...spans);
  }
  const window = { start: instantOf(a.timeMin) ?? 0, end: instantOf(a.timeMax) ?? 0 };
  const minutes = num(a.durationMinutes) ?? DEFAULT_DURATION_MINUTES;
  const slots = freeSlots(
    window,
    busy,
    minutes * 60_000,
    num(a.maxSuggestions) ?? DEFAULT_SUGGESTIONS,
  );
  return {
    durationMinutes: minutes,
    freeSlots: slots.map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
    })),
    ...(unknown.length > 0
      ? {
          availabilityUnknown: unknown,
          note: 'Google could not tell when these people are busy (their calendar is not shared with this account, or does not exist): the slots do not account for them.',
        }
      : {}),
  };
}

/** `list_calendars`: the mission's calendars, as discovery described them. */
function listCalendarsResult(calendars: readonly Resource[]): McpToolResult {
  const listed = calendars.map((c) => ({
    calendar: c.ref,
    id: calendarIdOf(c.ref),
    name: c.displayName,
    primary: c.metadata?.primary === true,
    ...(typeof c.metadata?.access_role === 'string' ? { accessRole: c.metadata.access_role } : {}),
  }));
  return jsonResult({ calendars: listed });
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

interface CalendarListPage {
  readonly items?: readonly unknown[];
  readonly nextPageToken?: string;
}

function isCalendarListPage(x: unknown): x is CalendarListPage {
  return (
    isRecord(x) &&
    (x.items === undefined || isList(x.items)) &&
    (x.nextPageToken === undefined || typeof x.nextPageToken === 'string')
  );
}

/**
 * The calendars of the account, from `GET /users/me/calendarList`, page by
 * page while Google gives a `nextPageToken`. A calendar is an entry whose
 * `id` is in the calendar grammar (`identifiers.ts`); Google's subscribed
 * calendars (holidays, birthdays: an id with `#`) are outside it and left
 * out, and so are hidden entries (Google's default). Each resource carries
 * `primary`, `access_role`, `account_email` (the primary calendar's id) and
 * `internal_domains`, the list the classifier zones invited people with,
 * which the owner edits — seeded with the account's domain unless it is a
 * consumer one.
 *
 * A token Google granted fewer scopes than asked is refused first, in the
 * gateway's words (`CredentialRefusal`).
 */
export async function discoverGoogleCalendarResources(
  ctx: AccountContext,
): Promise<readonly Resource[]> {
  expectRequiredScopes(ctx);
  const found = new Map<string, FoundCalendar>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const answer = await listCalendarPage(ctx, pageToken);
    for (const calendar of calendarsIn(answer.items ?? [])) {
      if (!found.has(calendar.id)) found.set(calendar.id, calendar);
    }
    const next = answer.nextPageToken;
    pageToken = next !== undefined && next.length > 0 && next.length <= 512 ? next : undefined;
    if (pageToken === undefined || found.size >= MAX_DISCOVERED_CALENDARS) break;
  }
  return resourcesOf([...found.values()].slice(0, MAX_DISCOVERED_CALENDARS));
}

async function listCalendarPage(
  ctx: AccountContext,
  pageToken: string | undefined,
): Promise<CalendarListPage> {
  try {
    const answer = await request(ctx, 'GET', '/users/me/calendarList', {
      query: { maxResults: DISCOVERY_PAGE_SIZE, pageToken },
      guard: isCalendarListPage,
    });
    return answer ?? {};
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      const reason = googleErrorReason(err);
      if (reason !== null && NOT_A_CREDENTIAL_403.has(reason)) {
        throw new UpstreamHttpError(err.message, 403);
      }
      throw new CredentialRefusal(CALENDAR_API_REFUSED, 403);
    }
    throw err;
  }
}

export interface FoundCalendar {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
  readonly accessRole: string | null;
}

/** The calendars of calendarList entries, deduplicated, in order; anything else is ignored. */
export function calendarsIn(items: readonly unknown[]): FoundCalendar[] {
  const found = new Map<string, FoundCalendar>();
  for (const item of items) {
    const calendar = isRecord(item) ? calendarObject(item) : null;
    if (calendar && !found.has(calendar.id)) found.set(calendar.id, calendar);
  }
  return [...found.values()];
}

/** An entry that describes a calendar: an `id` of the grammar and a name (`summaryOverride`, `summary`). */
function calendarObject(o: Record<string, unknown>): FoundCalendar | null {
  if (typeof o.id !== 'string' || calendarRefOf(o.id) === null) return null;
  if (o.deleted === true) return null;
  const name = [o.summaryOverride, o.summary].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (name === undefined && o.primary !== true) return null;
  return {
    id: o.id,
    name: (name ?? o.id).trim().slice(0, 200),
    primary: o.primary === true,
    accessRole: typeof o.accessRole === 'string' ? o.accessRole.slice(0, 40) : null,
  };
}

/** The resources of the calendars found, with the facts the classifier zones by. */
export function resourcesOf(calendars: readonly FoundCalendar[]): Resource[] {
  const primary = calendars.find((c) => c.primary);
  const accountEmail = primary ? (parseAddress(primary.id)?.address ?? null) : null;
  const accountDomain = accountEmail?.split('@')[1] ?? null;
  const internal =
    accountDomain !== null && !CONSUMER_DOMAINS.has(accountDomain) ? [accountDomain] : [];
  const resources: Resource[] = [];
  for (const calendar of calendars) {
    const ref = calendarRefOf(calendar.id);
    if (ref === null) continue;
    resources.push({
      service: SERVICE_ID,
      ref,
      displayName: calendar.name,
      metadata: {
        primary: calendar.primary,
        ...(calendar.accessRole ? { access_role: calendar.accessRole } : {}),
        ...(accountEmail ? { account_email: accountEmail } : {}),
        internal_domains: internal,
      },
    });
  }
  return resources;
}
