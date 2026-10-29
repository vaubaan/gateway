/**
 * Identity of the `google-calendar` provider — the one place its ids and
 * Google's own names are written.
 *
 * Handbook : docs/handbook/providers/google-calendar.md.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md D4.
 *
 * `PROVIDER_ID` is also written as `provider:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. The tool prefix is the
 * SDK's rule (`toolPrefixFor`): `google_calendar__`.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

export const PROVIDER_ID = 'google-calendar';

/** `google_calendar__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(PROVIDER_ID);

/**
 * Google's official Calendar MCP server (Streamable HTTP, Developer Preview),
 * from "Configure the Calendar MCP server" (developers.google.com, read
 * 2026-10-27). It authenticates a Google access token as a Bearer.
 */
export const CALENDAR_MCP_URL = 'https://calendarmcp.googleapis.com/mcp/v1';

/** The broker provider whose OAuth client the access token is issued to. */
export const BROKER_PROVIDER = 'google';

/**
 * The scopes asked: the narrowest that cover the tools offered (ADR D4) —
 * never the full `calendar` scope.
 */
export const SCOPES = {
  calendarListRead: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  eventsRead: 'https://www.googleapis.com/auth/calendar.events.readonly',
  freeBusy: 'https://www.googleapis.com/auth/calendar.events.freebusy',
  events: 'https://www.googleapis.com/auth/calendar.events',
} as const;

/** The upstream tool names, as Google's reference lists them (9 tools). */
export const UPSTREAM_TOOL = {
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

export type UpstreamToolName = (typeof UPSTREAM_TOOL)[keyof typeof UPSTREAM_TOOL];

/** The gateway's name of an upstream tool. */
export function toolNameOf(upstream: string): string {
  return `${TOOL_PREFIX}${upstream}`;
}

/** The MCP tool names of the plugin, in the order `tools/list` gives them. */
export const TOOL = {
  listCalendars: toolNameOf(UPSTREAM_TOOL.listCalendars),
  listEvents: toolNameOf(UPSTREAM_TOOL.listEvents),
  searchEvents: toolNameOf(UPSTREAM_TOOL.searchEvents),
  getEvent: toolNameOf(UPSTREAM_TOOL.getEvent),
  suggestTime: toolNameOf(UPSTREAM_TOOL.suggestTime),
  createEvent: toolNameOf(UPSTREAM_TOOL.createEvent),
  updateEvent: toolNameOf(UPSTREAM_TOOL.updateEvent),
  deleteEvent: toolNameOf(UPSTREAM_TOOL.deleteEvent),
  respondToEvent: toolNameOf(UPSTREAM_TOOL.respondToEvent),
} as const;

/**
 * How each upstream tool is told its calendar:
 *   `none`      no calendar (free/busy of people);
 *   `primary`   the primary calendar only, by Google's rule (`search_events`);
 *   `calendar`  `calendarId`, the primary calendar when omitted.
 */
export type Locator = 'none' | 'primary' | 'calendar';

export const LOCATOR: Readonly<Record<string, Locator>> = {
  [UPSTREAM_TOOL.listEvents]: 'calendar',
  [UPSTREAM_TOOL.searchEvents]: 'primary',
  [UPSTREAM_TOOL.getEvent]: 'calendar',
  [UPSTREAM_TOOL.suggestTime]: 'none',
  [UPSTREAM_TOOL.createEvent]: 'calendar',
  [UPSTREAM_TOOL.updateEvent]: 'calendar',
  [UPSTREAM_TOOL.deleteEvent]: 'calendar',
  [UPSTREAM_TOOL.respondToEvent]: 'calendar',
};

/** The argument through which Google's tools name the calendar. */
export const CALENDAR_ARGUMENT = 'calendarId';
/** The argument through which Google's tools name an event. */
export const EVENT_ARGUMENT = 'eventId';
/** Google's keyword for the signed-in person's own calendar. */
export const PRIMARY_KEYWORD = 'primary';

/**
 * `list_calendars` is answered by the gateway from the mission's calendars:
 * Google's lists every calendar of the account, beyond the mission's.
 * Discovery calls Google's.
 */
export const ANSWERED_BY_THE_GATEWAY: ReadonlySet<string> = new Set([UPSTREAM_TOOL.listCalendars]);

/**
 * Arguments of an offered tool the gateway does not offer, each with the
 * reason. An agent that sends one is refused (undeclared argument).
 */
export const WITHHELD_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [UPSTREAM_TOOL.listCalendars]: {
    pageSize: 'the gateway answers from the mission’s calendars, in one page',
    pageToken: 'the gateway answers from the mission’s calendars, in one page',
  },
  [UPSTREAM_TOOL.listEvents]: { eventTypeFilter: 'deprecated by Google: use eventType' },
  [UPSTREAM_TOOL.createEvent]: { attendeeEmails: 'deprecated by Google: use attendees' },
  [UPSTREAM_TOOL.updateEvent]: { addedAttendeeEmails: 'deprecated by Google: use addedAttendees' },
};

/** Arguments that carry people: their addresses decide the zone of the call. */
export const ATTENDEE_OBJECTS_ARGUMENT: Readonly<Record<string, string>> = {
  [UPSTREAM_TOOL.createEvent]: 'attendees',
  [UPSTREAM_TOOL.updateEvent]: 'addedAttendees',
};
/** The fields of an attendee object the gateway forwards; any other is refused. */
export const ATTENDEE_FIELDS: ReadonlySet<string> = new Set(['email', 'displayName', 'optional']);

/**
 * The argument of the notification level, and the one value that sends no
 * email to the event's guests. Absent or any other value: Google notifies
 * them (`NOTIFICATION_LEVEL_UNSPECIFIED` is treated as `ALL`).
 */
export const NOTIFICATION_ARGUMENT = 'notificationLevel';
export const NO_NOTIFICATION = 'NONE';

/** What the gateway adds to Google's description of a tool, where it differs. */
export const CALENDAR_NOTE =
  'Through this gateway, calendarId is a calendar of the mission: its ref (alice~acme.com, the calendar id with @ written ~) or its id (alice@acme.com); omitted, the primary calendar, which must be in the mission. google_calendar__list_calendars names them.';

export const DESCRIPTION_NOTES: Readonly<Record<string, string>> = {
  [UPSTREAM_TOOL.searchEvents]:
    'Through this gateway it searches the primary calendar, which must be in the mission.',
  [UPSTREAM_TOOL.createEvent]:
    'Every attendee is one email address; inviting people inside or outside the company are separate permissions.',
  [UPSTREAM_TOOL.updateEvent]:
    'Unless notificationLevel is NONE, Google emails the current guests about the change: a permission of its own.',
  [UPSTREAM_TOOL.deleteEvent]:
    'Unless notificationLevel is NONE, Google emails the guests a cancellation: a permission of its own.',
};
