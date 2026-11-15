/**
 * The calendar tools of the `outlook` service on Microsoft Graph v1.0 —
 * the Google Calendar plugin's tools over Graph.
 *
 * Handbook : docs/handbook/services/outlook.md.
 *
 * An event is always reached under the calendar the call was classified on
 * (`/me/calendar/events/{id}` for `default`, `/me/calendars/{c}/events/{id}`
 * otherwise), never as `/me/events/{id}`, so the request names the calendar
 * the slice names. Times are asked and answered in UTC.
 */

import {
  ExecutorRefusal,
  isList,
  isRecord,
  jsonResult,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
} from '@vaubaan/plugin-sdk';

import { parseAddress } from './address.ts';
import type { OutlookCall } from './call.ts';
import { freeSlots, type Span } from './free-slots.ts';
import { graph, odataString, segment } from './graph.ts';
import {
  DEFAULT_CALENDAR,
  PREFER_TEXT_BODY,
  PREFER_UTC,
  RESPONSE_ACTION,
  TOOL,
  type ResponseKind,
} from './identity.ts';

const DEFAULT_EVENTS_TOP = 50;
const CALENDARS_PER_LIST = 100;
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_SUGGESTIONS = 10;
/** The granularity of getSchedule's answer, minutes (5 to 1440). */
const AVAILABILITY_INTERVAL = 15;

const SELECT_CALENDAR = 'id,name,isDefaultCalendar,canEdit,owner';
const SELECT_EVENT_LIST =
  'id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,isOrganizer,responseStatus,showAs,type,seriesMasterId,bodyPreview,webLink';
const SELECT_EVENT = `${SELECT_EVENT_LIST},body,recurrence,onlineMeeting`;

interface Page {
  readonly value: readonly unknown[];
}
const isPage: Guard<Page> = (x): x is Page => isRecord(x) && isList(x.value);

function calendarPath(call: OutlookCall): string {
  if (call.calendar === null) throw new ExecutorRefusal('calendar: missing.');
  return call.calendar === DEFAULT_CALENDAR
    ? '/me/calendar'
    : `/me/calendars/${segment(call.calendar, 'calendar')}`;
}

function eventPath(call: OutlookCall): string {
  return `${calendarPath(call)}/events/${segment(call.eventId, 'event_id')}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function top(call: OutlookCall): number {
  return typeof call.values.top === 'number' ? call.values.top : DEFAULT_EVENTS_TOP;
}

function calendarView(ctx: ExecuteContext, call: OutlookCall): Promise<Page | null> {
  const range = call.range;
  if (range === null) throw new ExecutorRefusal('start, end: missing.');
  return graph(ctx, 'GET', `${calendarPath(call)}/calendarView`, {
    query: {
      startDateTime: iso(range.start),
      endDateTime: iso(range.end),
      $top: top(call),
      $orderby: 'start/dateTime',
      $select: SELECT_EVENT_LIST,
    },
    prefer: [PREFER_UTC],
    guard: isPage,
  });
}

/**
 * `search_events`: in a range, the calendar view narrowed to the subjects
 * holding the text; without one, the calendar's events filtered by Graph
 * (`contains(subject, '…')`, the quote doubled).
 */
async function searchEvents(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const text = typeof call.values.text === 'string' ? call.values.text : '';
  if (call.range !== null) {
    const page = await calendarView(ctx, call);
    const needle = text.toLowerCase();
    return {
      value: (page?.value ?? []).filter(
        (e) =>
          isRecord(e) && typeof e.subject === 'string' && e.subject.toLowerCase().includes(needle),
      ),
      note: 'The first page of the range, narrowed to the subjects holding the text.',
    };
  }
  return graph(ctx, 'GET', `${calendarPath(call)}/events`, {
    query: {
      $filter: `contains(subject,${odataString(text)})`,
      $top: top(call),
      $select: SELECT_EVENT_LIST,
    },
    prefer: [PREFER_UTC],
    guard: isPage,
  });
}

// ─── suggest_time ───────────────────────────────────────────────────────────

/** Graph's dateTime in UTC (no offset, up to seven fraction digits) as milliseconds, or `null`. */
function utcInstant(value: unknown): number | null {
  if (!isRecord(value) || typeof value.dateTime !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d{1,7})?$/.exec(value.dateTime);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${(m[2] ?? '').slice(0, 4)}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The busy spans of one scheduleInformation, or `null` when Graph reports an error for it. */
function busyOf(entry: unknown): Span[] | null {
  if (!isRecord(entry) || (entry.error !== undefined && entry.error !== null)) return null;
  if (!isList(entry.scheduleItems)) return [];
  const spans: Span[] = [];
  for (const item of entry.scheduleItems) {
    if (!isRecord(item)) return null;
    if (item.status === 'free') continue;
    const start = utcInstant(item.start);
    const end = utcInstant(item.end);
    if (start === null || end === null) return null;
    spans.push({ start, end });
  }
  return spans;
}

async function suggestTime(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const range = call.range;
  if (range === null) throw new ExecutorRefusal('start, end: missing.');
  const self = call.zoning.account_email;
  const people = [...(self !== null ? [self] : []), ...call.attendees];
  const utc = (ms: number) => ({ dateTime: iso(ms).slice(0, 19), timeZone: 'UTC' });
  const answer = await graph(ctx, 'POST', '/me/calendar/getSchedule', {
    body: {
      schedules: people,
      startTime: utc(range.start),
      endTime: utc(range.end),
      availabilityViewInterval: AVAILABILITY_INTERVAL,
    },
    prefer: [PREFER_UTC],
    guard: isPage,
  });
  const byId = new Map<string, unknown>();
  for (const entry of answer?.value ?? []) {
    const id = isRecord(entry) ? parseAddress(entry.scheduleId)?.address : undefined;
    if (id !== undefined) byId.set(id, entry);
  }
  const busy: Span[] = [];
  const unknown: string[] = self === null ? ['this account'] : [];
  for (const person of people) {
    const spans = busyOf(byId.get(person));
    if (spans === null) unknown.push(person);
    else busy.push(...spans);
  }
  const minutes =
    typeof call.values.duration_minutes === 'number'
      ? call.values.duration_minutes
      : DEFAULT_DURATION_MINUTES;
  const max =
    typeof call.values.max_suggestions === 'number'
      ? call.values.max_suggestions
      : DEFAULT_SUGGESTIONS;
  const slots = freeSlots(range, busy, minutes * 60_000, max);
  return {
    durationMinutes: minutes,
    freeSlots: slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })),
    ...(unknown.length > 0
      ? {
          availabilityUnknown: unknown,
          note: 'Microsoft could not tell when these people are busy (their free/busy is not shared with this account, or the address is unknown): the slots do not account for them.',
        }
      : {}),
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

function attendeeObjects(addresses: readonly string[]): Record<string, unknown>[] {
  return addresses.map((address) => ({ emailAddress: { address }, type: 'required' }));
}

/** The fields of an event write the agent gave (attendees apart). */
function eventFields(call: OutlookCall): Record<string, unknown> {
  const v = call.values;
  return {
    ...(typeof v.subject === 'string' ? { subject: v.subject } : {}),
    ...(typeof v.body === 'string' ? { body: { contentType: 'text', content: v.body } } : {}),
    ...(typeof v.location === 'string' ? { location: { displayName: v.location } } : {}),
    ...(call.start !== null ? { start: call.start } : {}),
    ...(call.end !== null ? { end: call.end } : {}),
  };
}

/** What a write answers: the event's identity and times, not its body. */
function writtenEvent(answer: unknown): Record<string, unknown> {
  if (!isRecord(answer)) return {};
  const out: Record<string, unknown> = {};
  for (const field of ['id', 'subject', 'start', 'end', 'location', 'attendees', 'webLink']) {
    if (answer[field] !== undefined) out[field] = answer[field];
  }
  return out;
}

interface AttendeeOfEvent {
  readonly emailAddress: { readonly address: string; readonly name?: string };
  readonly type?: string;
}

function isAttendee(x: unknown): x is AttendeeOfEvent {
  return isRecord(x) && isRecord(x.emailAddress) && typeof x.emailAddress.address === 'string';
}

const isEventAttendees: Guard<{ readonly attendees?: readonly AttendeeOfEvent[] }> = (
  x,
): x is { readonly attendees?: readonly AttendeeOfEvent[] } =>
  isRecord(x) &&
  (x.attendees === undefined || (isList(x.attendees) && x.attendees.every(isAttendee)));

/**
 * The attendees after an update: the event's current ones, less the removed
 * addresses, plus the added people not already there. Graph replaces the
 * whole list on a PATCH, so the current one is read first.
 */
export function mergedAttendees(
  current: readonly AttendeeOfEvent[],
  added: readonly string[],
  removed: readonly string[],
): Record<string, unknown>[] {
  const gone = new Set(removed);
  const kept = current
    .filter((a) => !gone.has(a.emailAddress.address.toLowerCase()))
    .map((a) => ({
      emailAddress: { address: a.emailAddress.address },
      ...(typeof a.type === 'string' ? { type: a.type } : {}),
    }));
  const present = new Set(kept.map((a) => a.emailAddress.address.toLowerCase()));
  return [...kept, ...attendeeObjects(added.filter((a) => !present.has(a)))];
}

async function updateEvent(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const body = eventFields(call);
  if (call.attendees.length > 0 || call.removedAttendees.length > 0) {
    const event = await graph(ctx, 'GET', eventPath(call), {
      query: { $select: 'attendees' },
      guard: isEventAttendees,
    });
    body.attendees = mergedAttendees(event?.attendees ?? [], call.attendees, call.removedAttendees);
  }
  return writtenEvent(await graph(ctx, 'PATCH', eventPath(call), { body, prefer: [PREFER_UTC] }));
}

async function respondToEvent(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const kind = call.values.response as ResponseKind;
  const action = RESPONSE_ACTION[kind];
  if (action === undefined)
    throw new ExecutorRefusal('response: expected accept, tentative or decline.');
  const sendResponse = call.values.send_response === true;
  await graph(ctx, 'POST', `${eventPath(call)}/${action}`, {
    body: {
      ...(typeof call.values.comment === 'string' ? { comment: call.values.comment } : {}),
      sendResponse,
    },
  });
  return { event_id: call.eventId, response: kind, sent_to_organizer: sendResponse };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function executeCalendar(
  ctx: ExecuteContext,
  call: OutlookCall,
): Promise<McpToolResult> {
  switch (call.tool) {
    case TOOL.listCalendars:
      return jsonResult(
        await graph(ctx, 'GET', '/me/calendars', {
          query: { $top: CALENDARS_PER_LIST, $select: SELECT_CALENDAR },
          guard: isPage,
        }),
      );
    case TOOL.listEvents:
      return jsonResult(await calendarView(ctx, call));
    case TOOL.searchEvents:
      return jsonResult(await searchEvents(ctx, call));
    case TOOL.getEvent:
      return jsonResult(
        await graph(ctx, 'GET', eventPath(call), {
          query: { $select: SELECT_EVENT },
          prefer: [PREFER_UTC, PREFER_TEXT_BODY],
        }),
      );
    case TOOL.suggestTime:
      return jsonResult(await suggestTime(ctx, call));
    case TOOL.createEvent:
      return jsonResult(
        writtenEvent(
          await graph(ctx, 'POST', `${calendarPath(call)}/events`, {
            body: { ...eventFields(call), attendees: attendeeObjects(call.attendees) },
            prefer: [PREFER_UTC],
          }),
        ),
      );
    case TOOL.updateEvent:
      return jsonResult(await updateEvent(ctx, call));
    case TOOL.deleteEvent:
      await graph(ctx, 'DELETE', eventPath(call));
      return jsonResult({ deleted: true, event_id: call.eventId });
    case TOOL.respondToEvent:
      return jsonResult(await respondToEvent(ctx, call));
    default:
      throw new ExecutorRefusal(`unknown tool '${call.tool}'`);
  }
}
