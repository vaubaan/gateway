/**
 * Events : what a tool returns, what a tool writes.
 *
 * Handbook : docs/handbook/providers/caldav.md.
 *
 *   - **Read** (`eventView`) : one calendar object → JSON fields, the master
 *     event of a recurring series (the `VEVENT` without `RECURRENCE-ID`) and
 *     the count of its changed occurrences. Text from the server is
 *     unescaped and capped ; nothing of the raw iCalendar is returned.
 *   - **Create** (`buildEvent`) : a new `VCALENDAR` from the fields the
 *     classifier read, every value escaped (`escapeText`) and folded on
 *     output (`serializeIcs`).
 *   - **Change** (`applyChange`) : the server's object, the named properties
 *     rewritten in place on the master event, everything else — alarms,
 *     `X-` properties, attendees' answers — kept ; `SEQUENCE` incremented,
 *     `DTSTAMP` / `LAST-MODIFIED` set.
 *   - **Who is concerned** (`concernedPeople`) : every attendee and organizer
 *     of every `VEVENT` of the object, for the executor's check against what
 *     the call stated.
 */

import { addressOfCalAddress, type EmailAddress } from './address.ts';
import type { EventInput } from './classify.ts';
import {
  escapeText,
  paramOf,
  propertiesOf,
  propertyOf,
  removeProperties,
  setProperty,
  unescapeText,
  type IcsComponent,
  type IcsParam,
  type IcsProperty,
} from './ical.ts';
import { icsUtc, timeView } from './times.ts';

/** Characters of each text field returned. */
export const READ_CAPS = { summary: 500, location: 500, uid: 255, rrule: 500 } as const;
/** Characters of a description returned by `list_events` and by `get_event`. */
export const LIST_DESCRIPTION_CHARS = 2000;
export const GET_DESCRIPTION_CHARS = 8000;
/** Attendees returned per event. */
export const MAX_ATTENDEES_RETURNED = 100;

export interface PersonView {
  /** The e-mail address, or `null` when the calendar user address is not a `mailto:`. */
  readonly address: string | null;
  readonly name: string | null;
  /** `ACCEPTED`, `DECLINED`, `TENTATIVE`, `NEEDS-ACTION`… for an attendee. */
  readonly status: string | null;
  /** The raw calendar user address when it is not a `mailto:` (`urn:uuid:…`), capped. */
  readonly uri?: string;
}

export interface EventView {
  readonly uid: string | null;
  readonly summary: string | null;
  readonly start: string | null;
  readonly end: string | null;
  /** `DURATION` when the event has no `DTEND` (`PT1H`). */
  readonly duration: string | null;
  readonly timezone: string | null;
  readonly all_day: boolean;
  readonly location: string | null;
  readonly description: string | null;
  readonly description_truncated: boolean;
  readonly status: string | null;
  readonly organizer: PersonView | null;
  readonly attendees: readonly PersonView[];
  readonly attendees_truncated: boolean;
  /** The `RRULE` of a recurring event, as written (`FREQ=WEEKLY;BYDAY=MO`). */
  readonly recurrence: string | null;
  /** Occurrences of the series changed one by one (`VEVENT`s with a `RECURRENCE-ID`). */
  readonly changed_occurrences: number;
}

const cap = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/** The `VEVENT`s of a calendar object. */
export const eventsOf = (calendar: IcsComponent): IcsComponent[] =>
  calendar.components.filter((c) => c.name === 'VEVENT');

/** The master event : the `VEVENT` without `RECURRENCE-ID`, else the first one ; `null` when there is none. */
export function masterOf(calendar: IcsComponent): IcsComponent | null {
  const events = eventsOf(calendar);
  return events.find((e) => propertyOf(e, 'RECURRENCE-ID') === undefined) ?? events[0] ?? null;
}

function textValue(event: IcsComponent, name: string, max: number): string | null {
  const p = propertyOf(event, name);
  return p === undefined ? null : cap(unescapeText(p.value), max);
}

function personView(property: IcsProperty): PersonView {
  const address = addressOfCalAddress(property.value);
  const name = paramOf(property, 'CN');
  const status = paramOf(property, 'PARTSTAT');
  return {
    address: address?.address ?? null,
    name: name === undefined ? null : cap(name, 100),
    status: status === undefined ? null : cap(status.toUpperCase(), 32),
    ...(address === null ? { uri: cap(property.value, 200) } : {}),
  };
}

/** The JSON fields of a calendar object, read from its master event ; `null` when it holds no event. */
export function eventView(calendar: IcsComponent, descriptionChars: number): EventView | null {
  const master = masterOf(calendar);
  if (master === null) return null;
  const start = timeView(propertyOf(master, 'DTSTART'));
  const end = timeView(propertyOf(master, 'DTEND'));
  const rawDescription = propertyOf(master, 'DESCRIPTION');
  const description = rawDescription === undefined ? null : unescapeText(rawDescription.value);
  const organizer = propertyOf(master, 'ORGANIZER');
  const attendees = propertiesOf(master, 'ATTENDEE');
  return {
    uid: textValue(master, 'UID', READ_CAPS.uid),
    summary: textValue(master, 'SUMMARY', READ_CAPS.summary),
    start: start?.time ?? null,
    end: end?.time ?? null,
    duration: end === null ? (propertyOf(master, 'DURATION')?.value.slice(0, 32) ?? null) : null,
    timezone: start?.timezone ?? null,
    all_day: start?.allDay ?? false,
    location: textValue(master, 'LOCATION', READ_CAPS.location),
    description: description === null ? null : cap(description, descriptionChars),
    description_truncated: description !== null && description.length > descriptionChars,
    status: textValue(master, 'STATUS', 32),
    organizer: organizer === undefined ? null : personView(organizer),
    attendees: attendees.slice(0, MAX_ATTENDEES_RETURNED).map(personView),
    attendees_truncated: attendees.length > MAX_ATTENDEES_RETURNED,
    recurrence: propertyOf(master, 'RRULE')?.value.slice(0, READ_CAPS.rrule) ?? null,
    changed_occurrences: eventsOf(calendar).filter((e) => propertyOf(e, 'RECURRENCE-ID')).length,
  };
}

/**
 * Every attendee and organizer of every event of the object, the people a
 * write may notify. A calendar user address that is not one `mailto:`
 * address is `null` : the classifier's zoning counts it as `external`.
 */
export function concernedPeople(calendar: IcsComponent): (EmailAddress | null)[] {
  const out: (EmailAddress | null)[] = [];
  for (const event of eventsOf(calendar)) {
    for (const p of [...propertiesOf(event, 'ORGANIZER'), ...propertiesOf(event, 'ATTENDEE')]) {
      out.push(addressOfCalAddress(p.value));
    }
  }
  return out;
}

/** The organizer's address of the master event, `undefined` when it has none, `null` when it is not a `mailto:`. */
export function organizerOf(calendar: IcsComponent): EmailAddress | null | undefined {
  const organizer = masterOf(calendar) && propertyOf(masterOf(calendar)!, 'ORGANIZER');
  return organizer ? addressOfCalAddress(organizer.value) : undefined;
}

// ─── Writing ───────────────────────────────────────────────────────────────

/** The product identifier the plugin writes (RFC 5545 §3.7.3). */
export const PRODID = '-//Vaubaan//Gateway CalDAV plugin//EN';

const mailto = (address: string): string => `mailto:${address}`;

function attendeeProperty(person: EmailAddress): IcsProperty {
  const params: IcsParam[] = [
    ...(person.name !== null ? [{ name: 'CN', values: [person.name] }] : []),
    { name: 'CUTYPE', values: ['INDIVIDUAL'] },
    { name: 'ROLE', values: ['REQ-PARTICIPANT'] },
    { name: 'PARTSTAT', values: ['NEEDS-ACTION'] },
    { name: 'RSVP', values: ['TRUE'] },
  ];
  return { name: 'ATTENDEE', params, value: mailto(person.address) };
}

const organizerProperty = (address: string): IcsProperty => ({
  name: 'ORGANIZER',
  params: [],
  value: mailto(address),
});

function setText(event: IcsComponent, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null) removeProperties(event, name);
  else setProperty(event, name, escapeText(value));
}

function setTimes(event: IcsComponent, times: NonNullable<EventInput['times']>): void {
  setProperty(event, 'DTSTART', times.start.value, times.start.params);
  setProperty(event, 'DTEND', times.end.value, times.end.params);
  removeProperties(event, 'DURATION');
}

/**
 * Attendees of the event replaced by `people` : an attendee kept keeps its
 * property (its answer, its role), a new one is invited, one not listed is
 * removed. The account itself is never added as an attendee by the plugin.
 */
function setAttendees(
  event: IcsComponent,
  people: readonly EmailAddress[],
  organizer: string | null,
): void {
  const existing = new Map<string, IcsProperty>();
  for (const p of propertiesOf(event, 'ATTENDEE')) {
    const address = addressOfCalAddress(p.value);
    if (address !== null && !existing.has(address.address)) existing.set(address.address, p);
  }
  removeProperties(event, 'ATTENDEE');
  const others = people.filter((p) => p.address !== organizer);
  if (others.length > 0 && organizer !== null && propertyOf(event, 'ORGANIZER') === undefined) {
    event.properties.push(organizerProperty(organizer));
  }
  for (const person of others) {
    event.properties.push(existing.get(person.address) ?? attendeeProperty(person));
  }
}

export interface BuildOptions {
  readonly uid: string;
  readonly now: Date;
  /** The account's address, organizer of an event with attendees ; `null` when unknown. */
  readonly organizer: string | null;
}

/** A new calendar object holding one event. */
export function buildEvent(input: EventInput, options: BuildOptions): IcsComponent {
  const stamp = icsUtc(options.now.getTime());
  const event: IcsComponent = {
    name: 'VEVENT',
    properties: [
      { name: 'UID', params: [], value: options.uid },
      { name: 'DTSTAMP', params: [], value: stamp },
      { name: 'CREATED', params: [], value: stamp },
      { name: 'LAST-MODIFIED', params: [], value: stamp },
      { name: 'SEQUENCE', params: [], value: '0' },
    ],
    components: [],
  };
  setText(event, 'SUMMARY', input.summary);
  if (input.times) setTimes(event, input.times);
  setText(event, 'LOCATION', input.location);
  setText(event, 'DESCRIPTION', input.description);
  if (input.attendees) setAttendees(event, input.attendees, options.organizer);
  return {
    name: 'VCALENDAR',
    properties: [
      { name: 'VERSION', params: [], value: '2.0' },
      { name: 'PRODID', params: [], value: PRODID },
      { name: 'CALSCALE', params: [], value: 'GREGORIAN' },
    ],
    components: [event],
  };
}

/**
 * The server's object with the call's changes applied to its master event, or
 * the sentence that declines them. `organizer` is the account's address.
 */
export function applyChange(
  calendar: IcsComponent,
  input: EventInput,
  options: { readonly now: Date; readonly organizer: string | null },
): string | null {
  const master = masterOf(calendar);
  if (master === null) return 'the object holds no event.';
  const overrides = eventsOf(calendar).filter((e) => e !== master).length;
  if (overrides > 0 && (input.times !== undefined || input.attendees !== undefined)) {
    return `this recurring event has ${overrides} occurrence(s) changed one by one: its time and its attendees are changed in a calendar application, not here.`;
  }
  setText(master, 'SUMMARY', input.summary);
  if (input.times) setTimes(master, input.times);
  setText(master, 'LOCATION', input.location);
  setText(master, 'DESCRIPTION', input.description);
  if (input.attendees) setAttendees(master, input.attendees, options.organizer);
  const sequence = Number.parseInt(propertyOf(master, 'SEQUENCE')?.value ?? '0', 10);
  setProperty(
    master,
    'SEQUENCE',
    String(Number.isFinite(sequence) && sequence >= 0 ? sequence + 1 : 1),
  );
  const stamp = icsUtc(options.now.getTime());
  setProperty(master, 'DTSTAMP', stamp);
  setProperty(master, 'LAST-MODIFIED', stamp);
  return null;
}
