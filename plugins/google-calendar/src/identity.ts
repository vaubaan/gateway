/**
 * Identity of the `google-calendar` service — the one place its ids and
 * Google's own names are written.
 *
 * Handbook : docs/handbook/services/google-calendar.md.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. The tool prefix is the
 * SDK's rule (`toolPrefixFor`): `google_calendar__`.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

export const SERVICE_ID = 'google-calendar';

/** `google_calendar__` : prepended to the bare tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * Google's public Calendar REST API v3 ("API reference", developers.google.com,
 * read 2026-11-02): every URI of the reference is relative to it. It
 * authenticates a Google access token as a Bearer.
 */
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

/** The broker provider whose OAuth client the access token is issued to. */
export const BROKER_PROVIDER = 'google';

/**
 * The scopes asked: the narrowest that cover the tools offered — never the
 * full `calendar` scope. `calendar.events` covers events.list / get / insert /
 * patch / delete and freeBusy.query; `calendarList.list` needs the calendar
 * list scope.
 */
export const SCOPES = {
  calendarListRead: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  events: 'https://www.googleapis.com/auth/calendar.events',
} as const;

/** The tool names without the prefix (9 tools). */
export const BARE_TOOL = {
  listCalendars: 'list_calendars',
  listEvents: 'list_events',
  searchEvents: 'search_events',
  getEvent: 'get_event',
  suggestTime: 'suggest_time',
  createEvent: 'create_event',
  updateEvent: 'update_event',
  deleteEvent: 'delete_event',
  respondToEvent: 'respond_to_event',
} as const;

export type BareToolName = (typeof BARE_TOOL)[keyof typeof BARE_TOOL];

/** The gateway's name of a bare tool name. */
export function toolNameOf(bare: string): string {
  return `${TOOL_PREFIX}${bare}`;
}

/** The MCP tool names of the plugin, in the order `tools/list` gives them. */
export const TOOL = {
  listCalendars: toolNameOf(BARE_TOOL.listCalendars),
  listEvents: toolNameOf(BARE_TOOL.listEvents),
  searchEvents: toolNameOf(BARE_TOOL.searchEvents),
  getEvent: toolNameOf(BARE_TOOL.getEvent),
  suggestTime: toolNameOf(BARE_TOOL.suggestTime),
  createEvent: toolNameOf(BARE_TOOL.createEvent),
  updateEvent: toolNameOf(BARE_TOOL.updateEvent),
  deleteEvent: toolNameOf(BARE_TOOL.deleteEvent),
  respondToEvent: toolNameOf(BARE_TOOL.respondToEvent),
} as const;

/** The argument that names the calendar (a ref or an id of the mission; the primary one when omitted). */
export const CALENDAR_ARGUMENT = 'calendarId';
/** The argument that names an event. */
export const EVENT_ARGUMENT = 'eventId';
/** Google's keyword for the signed-in person's own calendar. */
export const PRIMARY_KEYWORD = 'primary';

/** Arguments that carry people as attendee objects: their addresses decide the zone of the call. */
export const ATTENDEE_OBJECTS_ARGUMENT: Readonly<Record<string, string>> = {
  [BARE_TOOL.createEvent]: 'attendees',
  [BARE_TOOL.updateEvent]: 'addedAttendees',
};
/** Arguments that are lists of bare addresses. */
export const ADDRESS_LIST_ARGUMENTS: ReadonlySet<string> = new Set([
  'removedAttendeeEmails',
  'attendeeEmails',
]);
/** The fields of an attendee object the gateway forwards; any other is refused. */
export const ATTENDEE_FIELDS: ReadonlySet<string> = new Set(['email', 'displayName', 'optional']);

/**
 * Google's `sendUpdates` query parameter of events.insert / patch / delete,
 * and the one value that sends no email to the event's guests.
 */
export const NOTIFICATION_ARGUMENT = 'sendUpdates';
export const SEND_UPDATES = ['all', 'externalOnly', 'none'] as const;
export type SendUpdates = (typeof SEND_UPDATES)[number];
export const NO_NOTIFICATION: SendUpdates = 'none';
/**
 * What the gateway sends when the agent says nothing: a creation, a change
 * or a deletion tells the guests (`all`); an answer to an invitation tells
 * nobody but Google's own record (`none`).
 */
export const DEFAULT_SEND_UPDATES: Readonly<Record<string, SendUpdates>> = {
  [BARE_TOOL.createEvent]: 'all',
  [BARE_TOOL.updateEvent]: 'all',
  [BARE_TOOL.deleteEvent]: 'all',
  [BARE_TOOL.respondToEvent]: 'none',
};

/** The answers an attendee gives (events resource, `attendees[].responseStatus`, writable values). */
export const RESPONSE_STATUSES = ['accepted', 'declined', 'tentative'] as const;
