/**
 * Classifier of the `caldav` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *            ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/caldav.md, "Tool → slice mapping" and "Edge cases".
 *
 * Pure : no IO, no credential, no clock. Every slice is rooted at the
 * calendar the call names, one of the mission's resources. Rules :
 *
 *   1. One calendar per call : `calendar` names one of the mission's calendars,
 *      or is omitted when the mission holds exactly one. Anything else is
 *      denied — never the single calendar as a silent substitute.
 *   2. A read over more than 31 days adds `wide-range.R` ; over more than
 *      366 days, or with a bound that does not parse, it is denied.
 *   3. A write is `event.W` (create), `event[id].W` (change) or
 *      `event[id].delete.W` (delete), plus `attendee-zone[<z>].W` when the
 *      people the call names — the `attendees` argument — are not only the
 *      account itself. The zone is the worst of them : `internal` <
 *      `allowlist` < `external`. An attendee that does not parse as one
 *      address refuses the call.
 *   4. For a change or a deletion, who the server will notify is stated in
 *      `attendees` and priced here ; `execute` reads the event first and
 *      declines when it concerns somebody in a worse zone than the one
 *      priced (handbook, "Edge cases"). The classifier cannot read the
 *      server, so the statement is what it classifies — and what the
 *      executor holds the call to.
 *   5. Identifiers are checked by the grammars `execute` uses (`calendarRef`,
 *      `eventId`, `etagValue`) ; a value outside them is refused, never
 *      escaped (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *      An argument the tool does not declare refuses the call.
 */

import {
  declaredArgumentsOf,
  identSegment,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { collectAttendees, type EmailAddress } from './address.ts';
import { CALDAV_PLUGIN_ID, CALDAV_TOOLS, TOOL } from './identity.ts';
import { eventTime, readRange, timeZoneName, type EventTime, type EventTimeKind } from './times.ts';
import { caldavTools } from './tools.ts';

// ─── Grammars shared with execute ──────────────────────────────────────────

/**
 * A calendar ref : the last segment of the calendar's address when it is made
 * of these characters (`personal`, `home`, a UUID), or the `cal-<hex>` digest
 * discovery gives it otherwise. Never `.` or `..` (the first character cannot
 * be a dot), never a separator or an escape.
 */
const CALENDAR_REF = /^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,127}$/;

/**
 * An event id : the file name of the event in its calendar, as `list_events`
 * returns it (`3f2a…-9c.ics`, `abc123@google.com.ics`). One path segment :
 * no `/`, no `%`, no `?` or `#`, never `.` or `..` (the first character
 * cannot be a dot). It lands in the request path, `encodeURIComponent`ed.
 */
const EVENT_ID = /^[A-Za-z0-9_~+=@-][A-Za-z0-9_.~+=@-]{0,254}$/;

/** An entity tag as the server sent it (`"6d1-5f2"`, `W/"abc"`) : printable ASCII, no space, bounded. */
const ETAG = /^[\x21-\x7e]{1,256}$/;

export const calendarRef = (value: unknown): string | null =>
  typeof value === 'string' && CALENDAR_REF.test(value) ? value : null;

export const eventId = (value: unknown): string | null =>
  typeof value === 'string' && EVENT_ID.test(value) ? value : null;

export const etagValue = (value: unknown): string | null =>
  typeof value === 'string' && ETAG.test(value) ? value : null;

// ─── Zoning (owner-edited lists, on the calendar resource) ─────────────────

export type AttendeeZone = 'none' | 'internal' | 'allowlist' | 'external';

const ZONE_RANK: Readonly<Record<AttendeeZone, number>> = {
  none: 0,
  internal: 1,
  allowlist: 2,
  external: 3,
};

/** The worse of two zones. */
export const worseZone = (a: AttendeeZone, b: AttendeeZone): AttendeeZone =>
  ZONE_RANK[a] >= ZONE_RANK[b] ? a : b;

/** `a` reaches people `b` does not cover. */
export const zoneExceeds = (a: AttendeeZone, b: AttendeeZone): boolean =>
  ZONE_RANK[a] > ZONE_RANK[b];

/** The non-secret facts the classifier reads from `Resource.metadata`. */
export interface CalendarZoning {
  readonly internal_domains: readonly string[];
  readonly allowlist_domains: readonly string[];
  readonly allowlist_addresses: readonly string[];
  /** The account's own addresses (discovery : `calendar-user-address-set`) ; never notified. */
  readonly account_addresses: readonly string[];
}

/** Keys of `Resource.metadata` the classifier reads ; the three lists are the owner's to edit. */
export const CALDAV_METADATA_KEYS = [
  'internal_domains',
  'allowlist_domains',
  'allowlist_addresses',
  'account_addresses',
] as const;

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[\s,]+/).filter((s) => s.length > 0);
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** The zoning of a calendar resource ; a missing or ill-typed list is empty. */
export function readZoning(resource: Resource): CalendarZoning {
  const raw: Readonly<Record<string, unknown>> = resource.metadata ?? {};
  const lower = (s: string): string => s.trim().toLowerCase();
  return {
    internal_domains: stringList(raw.internal_domains).map(lower),
    allowlist_domains: stringList(raw.allowlist_domains).map(lower),
    allowlist_addresses: stringList(raw.allowlist_addresses).map(lower),
    account_addresses: stringList(raw.account_addresses).map(lower),
  };
}

/** The zone of one person : `none` for the account itself. */
export function zoneOfAddress(address: EmailAddress, zoning: CalendarZoning): AttendeeZone {
  if (zoning.account_addresses.includes(address.address)) return 'none';
  if (zoning.internal_domains.includes(address.domain)) return 'internal';
  if (zoning.allowlist_addresses.includes(address.address)) return 'allowlist';
  if (zoning.allowlist_domains.includes(address.domain)) return 'allowlist';
  return 'external';
}

/** The worst zone of a list of people ; `none` when empty. An unreadable entry (`null`) is `external`. */
export function zoneOf(
  people: readonly (EmailAddress | null)[],
  zoning: CalendarZoning,
): AttendeeZone {
  let worst: AttendeeZone = 'none';
  for (const person of people) {
    worst = worseZone(worst, person === null ? 'external' : zoneOfAddress(person, zoning));
  }
  return worst;
}

// ─── Event fields (shared with execute) ────────────────────────────────────

export const MAX_SUMMARY_LENGTH = 500;
export const MAX_LOCATION_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 8000;

/** A control character other than a tab or a line break. */
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** What a create or a change writes ; a field left `undefined` is not touched. */
export interface EventInput {
  readonly summary?: string;
  /** `null` removes the property. */
  readonly location?: string | null;
  readonly description?: string | null;
  readonly times?: {
    readonly start: EventTime;
    readonly end: EventTime;
    readonly kind: EventTimeKind;
  };
  /** `undefined` when the call does not name them. */
  readonly attendees?: readonly EmailAddress[];
}

type Problem = { readonly denied: string };

function textField(
  args: Readonly<Record<string, unknown>>,
  key: string,
  max: number,
  removable: boolean,
): string | null | undefined | Problem {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return { denied: `${key}: expected a string.` };
  if (value.length > max) return { denied: `${key}: at most ${max} characters.` };
  if (TEXT_CONTROL.test(value)) return { denied: `${key}: holds a control character.` };
  if (value.trim().length === 0) {
    return removable ? null : { denied: `${key}: must not be empty.` };
  }
  return value;
}

const isProblem = (v: unknown): v is Problem =>
  typeof v === 'object' && v !== null && 'denied' in v;

/**
 * The event fields of `create_event` (`mode: 'create'` : `summary`, `start`
 * and `end` required) or `update_event` (`'update'` : at least one field,
 * `start` and `end` together). One function for `classify` and `execute`.
 */
export function readEventInput(
  args: Readonly<Record<string, unknown>>,
  mode: 'create' | 'update',
): EventInput | Problem {
  const summary = textField(args, 'summary', MAX_SUMMARY_LENGTH, false);
  if (isProblem(summary)) return summary;
  const location = textField(args, 'location', MAX_LOCATION_LENGTH, mode === 'update');
  if (isProblem(location)) return location;
  const description = textField(args, 'description', MAX_DESCRIPTION_LENGTH, mode === 'update');
  if (isProblem(description)) return description;
  if (mode === 'create' && summary === undefined) return { denied: 'summary: missing.' };

  const times = readTimes(args, mode);
  if (isProblem(times)) return times;

  let attendees: readonly EmailAddress[] | undefined;
  if (args.attendees !== undefined) {
    const collected = collectAttendees(args.attendees);
    if ('denied' in collected) return collected;
    attendees = collected.attendees;
  }

  const input: EventInput = {
    ...(summary !== undefined && summary !== null ? { summary } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(times !== undefined ? { times } : {}),
    ...(attendees !== undefined ? { attendees } : {}),
  };
  if (mode === 'update' && Object.keys(input).length === 0) {
    return {
      denied:
        'nothing to change: give at least one of summary, location, description, start and end, attendees.',
    };
  }
  return input;
}

function readTimes(
  args: Readonly<Record<string, unknown>>,
  mode: 'create' | 'update',
): EventInput['times'] | Problem {
  const { start, end, all_day: allDay, timezone } = args;
  const given = start !== undefined || end !== undefined;
  if (!given) {
    if (mode === 'create') return { denied: 'start: missing.' };
    if (allDay !== undefined || timezone !== undefined) {
      return { denied: 'all_day and timezone are read with start and end only.' };
    }
    return undefined;
  }
  if (start === undefined || end === undefined) {
    return { denied: 'start and end: give both, or neither.' };
  }
  if (allDay !== undefined && typeof allDay !== 'boolean') {
    return { denied: 'all_day: expected true or false.' };
  }
  let zone: string | null = null;
  if (timezone !== undefined) {
    zone = timeZoneName(timezone);
    if (zone === null) return { denied: "timezone: not an IANA time zone name ('Europe/Paris')." };
    if (allDay === true) return { denied: 'timezone: an all-day event has none.' };
  }
  const kind: EventTimeKind = allDay === true ? 'date' : zone !== null ? 'zoned' : 'instant';
  const from = eventTime(start, kind, zone);
  if (typeof from === 'string') return { denied: `start: ${from}` };
  const to = eventTime(end, kind, zone);
  if (typeof to === 'string') return { denied: `end: ${to}` };
  if (to.order <= from.order) return { denied: 'end: must be after start.' };
  return { start: from, end: to, kind };
}

/**
 * The people a write states it concerns, the ones the classifier prices :
 * `attendees` (create : the invited ; change : the list after the change ;
 * delete : the attendees and organizer of the event, as `get_event` listed
 * them), plus, for a change, `removed_attendees` (the people taken off the
 * event, whom the server sends a cancellation). The executor holds a change
 * or a deletion to it : the server's copy may concern nobody in a worse zone.
 */
export function statedPeople(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly EmailAddress[] | Problem {
  const attendees = collectAttendees(args.attendees);
  if ('denied' in attendees) return attendees;
  if (tool !== TOOL.updateEvent) return attendees.attendees;
  const removed = collectAttendees(args.removed_attendees);
  if ('denied' in removed) return { denied: `removed_${removed.denied}` };
  return [...attendees.attendees, ...removed.attendees];
}

// ─── Resource selection ────────────────────────────────────────────────────

/** The calendars of the mission. */
export const ownCalendars = (resources: readonly Resource[]): Resource[] =>
  resources.filter((r) => r.provider === CALDAV_PLUGIN_ID);

/**
 * The calendar a call targets, for `classify` and `execute` alike : the one
 * `calendar` names, which must be a calendar of the mission, or the mission's
 * single calendar when the argument is absent.
 */
export function resolveCalendar(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): Resource | { denied: string } {
  const own = ownCalendars(resources);
  if (args.calendar !== undefined) {
    const ref = calendarRef(args.calendar);
    if (ref === null) return { denied: 'calendar: malformed (list_calendars gives the ids).' };
    const found = own.find((r) => r.ref === ref);
    return found ?? { denied: `calendar '${ref}' is not a calendar of this mission.` };
  }
  if (own.length === 1) return own[0]!;
  return {
    denied:
      own.length === 0
        ? 'no calendar is a resource of this mission.'
        : `calendar: missing, and this mission has ${own.length} calendars — name one (list_calendars).`,
  };
}

// ─── Slices ────────────────────────────────────────────────────────────────

const name = (value: string): SliceSegment => ({ kind: 'name', value });

function slice(action: 'R' | 'W', calendar: string, rest: readonly SliceSegment[]): Slice {
  return {
    provider: CALDAV_PLUGIN_ID,
    path: [name('calendar'), identSegment(calendar), ...rest],
    action,
  };
}

const zoneSlice = (calendar: string, zone: AttendeeZone): Slice | null =>
  zone === 'none'
    ? null
    : slice('W', calendar, [name('attendee-zone'), { kind: 'ident', value: zone }]);

/** A required identifier checked by its grammar, or the denial that names it. */
function requireArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
  grammar: (value: unknown) => string | null,
  hint: string,
): string | Problem {
  const value = args[key];
  if (value === undefined || value === '') return { denied: `${key}: missing.` };
  return grammar(value) ?? { denied: `${key}: malformed (${hint}).` };
}

const EVENT_HINT = 'the event_id list_events or get_event returned';
const ETAG_HINT = 'the etag get_event or list_events returned';

/** Default and largest `max_results` of `list_events`. */
export const DEFAULT_MAX_RESULTS = 50;
export const MAX_MAX_RESULTS = 200;

/** `max_results` of `list_events`, or `null` when it is not an integer from 1 to `MAX_MAX_RESULTS`. */
export function maxResultsOf(value: unknown): number | null {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MAX_RESULTS
    ? value
    : null;
}

const DECLARED = declaredArgumentsOf(caldavTools);

// ─── Classifier ────────────────────────────────────────────────────────────

export function classifyCaldav(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (!CALDAV_TOOLS.includes(tool)) return { denied: `unknown caldav tool '${tool}'.` };
  const undeclared = undeclaredArgumentDenial(DECLARED, tool, args);
  if (undeclared !== null) return { denied: undeclared };

  if (tool === TOOL.listCalendars) {
    const own = ownCalendars(resources);
    if (own.length === 0) return { denied: 'no calendar is a resource of this mission.' };
    return { slices: own.map((r) => slice('R', r.ref, [])) };
  }

  const calendar = resolveCalendar(args, resources);
  if ('denied' in calendar) return calendar;
  const ref = calendar.ref;

  switch (tool) {
    case TOOL.listEvents: {
      const range = readRange(args.start, args.end);
      if ('denied' in range) return range;
      if (maxResultsOf(args.max_results) === null) {
        return { denied: `max_results: an integer from 1 to ${MAX_MAX_RESULTS}.` };
      }
      const slices = [slice('R', ref, [name('event'), { kind: 'ident', value: '*' }])];
      if (range.wide) slices.push(slice('R', ref, [name('wide-range')]));
      return { slices };
    }

    case TOOL.getEvent: {
      const id = requireArg(args, 'event_id', eventId, EVENT_HINT);
      if (isProblem(id)) return id;
      return { slices: [slice('R', ref, [name('event'), identSegment(id)])] };
    }

    case TOOL.createEvent: {
      const input = readEventInput(args, 'create');
      if (isProblem(input)) return input;
      const zone = zoneSlice(ref, zoneOf(input.attendees ?? [], readZoning(calendar)));
      const slices = [slice('W', ref, [name('event')])];
      return { slices: zone ? [...slices, zone] : slices };
    }

    case TOOL.updateEvent:
    case TOOL.deleteEvent: {
      const id = requireArg(args, 'event_id', eventId, EVENT_HINT);
      if (isProblem(id)) return id;
      const etag = requireArg(args, 'etag', etagValue, ETAG_HINT);
      if (isProblem(etag)) return etag;
      if (tool === TOOL.updateEvent) {
        const input = readEventInput(args, 'update');
        if (isProblem(input)) return input;
      }
      const people = statedPeople(tool, args);
      if (isProblem(people)) return people;
      const target = [name('event'), identSegment(id)];
      const containment =
        tool === TOOL.deleteEvent
          ? slice('W', ref, [...target, name('delete')])
          : slice('W', ref, target);
      const zone = zoneSlice(ref, zoneOf(people, readZoning(calendar)));
      return { slices: zone ? [containment, zone] : [containment] };
    }

    default:
      return { denied: `unknown caldav tool '${tool}'.` };
  }
}
