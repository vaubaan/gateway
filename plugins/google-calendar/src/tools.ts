/**
 * MCP tools of the `google-calendar` service — the plugin's own, each
 * implemented on Google's Calendar REST API v3 (`execute.ts`).
 *
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md.
 * Handbook : docs/handbook/services/google-calendar.md.
 *
 * Every tool but `list_calendars` and `suggest_time` takes `calendarId`, a
 * calendar of the mission (its ref or its id), the primary one when omitted.
 * Arguments are Google's REST names where they map one to one (`timeMin`,
 * `q`, `maxResults`, `sendUpdates`…), flattened where Google nests (an
 * event's start and end are `startTime` / `endTime` with `allDay`). `call.ts`
 * reads every call against these schemas: an undeclared argument is refused,
 * types, enums and integer bounds are checked.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { RESPONSE_STATUSES, SEND_UPDATES, TOOL } from './identity.ts';

/** The most events one page of `list_events` / `search_events` returns (Google allows 2500). */
export const MAX_EVENTS_PER_PAGE = 250;
/** The most people `suggest_time` asks about (freeBusy's `calendarExpansionMax` is 50, the account takes one). */
export const MAX_FREE_BUSY_PEOPLE = 49;

const CALENDAR = {
  calendarId: {
    type: 'string',
    description:
      'A calendar of this mission: its ref (alice~acme.com, the calendar id with @ written ~) or its id (alice@acme.com). Omitted: the primary calendar, which must be in the mission. google_calendar__list_calendars names them.',
  },
} as const;

const EVENT_ID = {
  eventId: {
    type: 'string',
    description: 'The event id (an instance of a recurring event included).',
  },
} as const;

const TIME_RANGE = {
  timeMin: {
    type: 'string',
    description:
      'Lower bound (exclusive) of an event’s end time, RFC3339 with an offset (2026-11-03T00:00:00Z).',
  },
  timeMax: {
    type: 'string',
    description:
      'Upper bound (exclusive) of an event’s start time, RFC3339 with an offset; greater than timeMin.',
  },
} as const;

const PAGING = {
  maxResults: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_EVENTS_PER_PAGE,
    description: `Events per page, 1 to ${MAX_EVENTS_PER_PAGE}. Default 50.`,
  },
  pageToken: { type: 'string', description: 'The nextPageToken of the previous page.' },
} as const;

const TIME_ZONE = {
  timeZone: {
    type: 'string',
    description: 'IANA time zone (Europe/Paris) of the answer’s times. Default: the calendar’s.',
  },
} as const;

const SEND_UPDATES_ARG = (what: string, byDefault: string) => ({
  sendUpdates: {
    type: 'string',
    enum: [...SEND_UPDATES],
    description: `${what} all: every guest; externalOnly: guests without Google Calendar; none: nobody. Default: ${byDefault}.`,
  },
});

const ATTENDEE = {
  type: 'object',
  properties: {
    email: { type: 'string', description: 'Exactly one email address, nothing else.' },
    displayName: { type: 'string' },
    optional: { type: 'boolean' },
  },
  required: ['email'],
} as const;

const EVENT_FIELDS = {
  summary: { type: 'string', description: 'Title.' },
  description: { type: 'string', description: 'Description; may contain HTML.' },
  location: { type: 'string', description: 'Free-text place.' },
  startTime: {
    type: 'string',
    description:
      'Start: RFC3339 (2026-11-03T10:00:00+01:00), or a date (2026-11-03) when allDay is true.',
  },
  endTime: {
    type: 'string',
    description:
      'End (exclusive): RFC3339, or a date when allDay is true (the day after the last day).',
  },
  allDay: { type: 'boolean', description: 'startTime and endTime are dates.' },
  ...TIME_ZONE,
  recurrence: {
    type: 'array',
    items: { type: 'string' },
    description:
      'RRULE, EXRULE, RDATE or EXDATE lines (RFC 5545); a recurring event needs timeZone.',
  },
  visibility: { type: 'string', enum: ['default', 'public', 'private', 'confidential'] },
  transparency: {
    type: 'string',
    enum: ['opaque', 'transparent'],
    description: 'opaque blocks time (busy), transparent does not.',
  },
  colorId: { type: 'string', description: 'An event colour id (1 to 11).' },
  addGoogleMeet: {
    type: 'boolean',
    description: 'true: Google creates a Meet link for the event.',
  },
} as const;

export const googleCalendarTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listCalendars,
    description:
      'List the Google calendars of this mission: for each, its ref (what calendarId of the other tools takes), its id, its name and whether it is the primary calendar. Answered by the gateway, without a call to Google.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.listEvents,
    description:
      'List the events of a calendar, in a time range. Recurring events are expanded into their instances and ordered by start time unless singleEvents is false.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALENDAR,
        ...TIME_RANGE,
        q: {
          type: 'string',
          description: 'Free text matched against title, description, location, guests.',
        },
        singleEvents: {
          type: 'boolean',
          description:
            'Expand recurring events into instances (default true). false lists the recurring events themselves.',
        },
        orderBy: {
          type: 'string',
          enum: ['startTime', 'updated'],
          description: 'startTime (default; needs singleEvents) or updated.',
        },
        ...PAGING,
        ...TIME_ZONE,
      },
    },
  },
  {
    name: TOOL.searchEvents,
    description:
      'Search the events of a calendar (the primary one when calendarId is omitted) by free text: title, description, location, guests. Text matching, not semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALENDAR,
        q: { type: 'string', description: 'The text to look for.' },
        ...TIME_RANGE,
        ...PAGING,
        ...TIME_ZONE,
      },
      required: ['q'],
    },
  },
  {
    name: TOOL.getEvent,
    description: 'Read one event of a calendar.',
    inputSchema: {
      type: 'object',
      properties: { ...CALENDAR, ...EVENT_ID, ...TIME_ZONE },
      required: ['eventId'],
    },
  },
  {
    name: TOOL.suggestTime,
    description:
      'Suggest times when this account and the people named are all free, from their busy slots (never their events) as far as their calendars share them. Returns the free slots of at least durationMinutes inside the window, and the people whose availability Google could not tell.',
    inputSchema: {
      type: 'object',
      properties: {
        attendeeEmails: {
          type: 'array',
          items: { type: 'string' },
          description: `Up to ${MAX_FREE_BUSY_PEOPLE} email addresses; this account is always included.`,
        },
        ...TIME_RANGE,
        durationMinutes: {
          type: 'integer',
          minimum: 5,
          maximum: 1440,
          description: 'Length of the meeting, 5 to 1440 minutes. Default 30.',
        },
        maxSuggestions: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many slots to return, 1 to 50. Default 10.',
        },
      },
      required: ['attendeeEmails', 'timeMin', 'timeMax'],
    },
  },
  {
    name: TOOL.createEvent,
    description:
      'Create an event on a calendar. Every attendee is one email address; inviting people inside or outside the company are separate permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALENDAR,
        ...EVENT_FIELDS,
        attendees: { type: 'array', items: ATTENDEE, description: 'The people to invite.' },
        ...SEND_UPDATES_ARG('Who Google emails the invitation to:', 'all'),
      },
      required: ['summary', 'startTime', 'endTime'],
    },
  },
  {
    name: TOOL.updateEvent,
    description:
      'Change an event: only the fields given change. startTime and endTime go together. Unless sendUpdates is none, Google emails the current guests about the change: a permission of its own.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALENDAR,
        ...EVENT_ID,
        ...EVENT_FIELDS,
        addedAttendees: { type: 'array', items: ATTENDEE, description: 'People to invite.' },
        removedAttendeeEmails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Guests to remove, by email address.',
        },
        ...SEND_UPDATES_ARG('Who Google emails the change to:', 'all'),
      },
      required: ['eventId'],
    },
  },
  {
    name: TOOL.deleteEvent,
    description:
      'Delete an event. Unless sendUpdates is none, Google emails the guests a cancellation: a permission of its own.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALENDAR,
        ...EVENT_ID,
        ...SEND_UPDATES_ARG('Who Google emails the cancellation to:', 'all'),
      },
      required: ['eventId'],
    },
  },
  {
    name: TOOL.respondToEvent,
    description:
      'Answer an invitation this account received: accepted, tentative or declined, with an optional comment. Only this account’s answer changes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CALENDAR,
        ...EVENT_ID,
        responseStatus: { type: 'string', enum: [...RESPONSE_STATUSES] },
        responseComment: { type: 'string', description: 'A comment the organizer reads.' },
        ...SEND_UPDATES_ARG('Who Google emails the answer to:', 'none'),
      },
      required: ['eventId', 'responseStatus'],
    },
  },
];
