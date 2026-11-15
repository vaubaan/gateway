/**
 * Tools of the `caldav` service.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins).
 * Handbook : docs/handbook/services/caldav.md.
 *
 * Six tools : the calendars, events over a time range, one event, and
 * creating, changing and deleting one. They read and write events as JSON
 * fields ; the plugin builds the iCalendar itself, and never takes or returns
 * a raw iCalendar text. The argument names are the ones the classifier and
 * the executor read ; the argument surface is closed (an undeclared argument
 * refuses the call).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

const calendarArg = {
  calendar: {
    type: 'string',
    description:
      'The calendar id list_calendars returns. May be omitted when the mission has a single calendar.',
  },
};
const eventIdArg = {
  event_id: {
    type: 'string',
    description: 'The event_id list_events or get_event returned (the file name of the event).',
  },
};
const etagArg = {
  etag: {
    type: 'string',
    description:
      'The etag get_event or list_events returned. The write is refused if the event changed since: read it again.',
  },
};
const addresses = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `${description} One address per element, as \`addr@example.com\` or \`Name <addr@example.com>\`; an element that is not exactly one address refuses the call.`,
});
const eventFields = {
  summary: { type: 'string', description: 'The title, at most 500 characters.' },
  start: {
    type: 'string',
    description:
      "An instant with its offset ('2026-10-27T09:30:00Z', '2026-10-27T10:30:00+01:00'); a wall-clock time ('2026-10-27T10:30:00') with timezone; a date ('2026-10-27') with all_day.",
  },
  end: {
    type: 'string',
    description:
      'Same form as start, after it. For an all-day event, the day after the last day (exclusive).',
  },
  timezone: {
    type: 'string',
    description:
      "IANA time zone of start and end ('Europe/Paris'): the event keeps local time across daylight saving changes.",
  },
  all_day: { type: 'boolean', description: 'true for an all-day event: start and end are dates.' },
  location: { type: 'string', description: 'The place, at most 500 characters.' },
  description: { type: 'string', description: 'The notes, at most 8000 characters.' },
};

export const caldavTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listCalendars,
    description:
      'List the calendars of this mission: id, name and description. The id is the calendar argument of the other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.listEvents,
    description:
      'List the events of a calendar that overlap a time range, oldest first: title, start, end, time zone, place, description (capped), organizer, attendees, recurrence rule, uid, event_id and etag. A recurring event is returned once, as its series. The range is at most 366 days; more than 31 days is a wide read. At most max_results events.',
    inputSchema: {
      type: 'object',
      properties: {
        ...calendarArg,
        start: {
          type: 'string',
          description:
            "Start of the range: a date ('2026-10-27', midnight UTC) or an instant with its offset ('2026-10-27T00:00:00+01:00').",
        },
        end: { type: 'string', description: 'End of the range, same form, after start.' },
        max_results: {
          type: 'integer',
          description: 'Events to return: 50 by default, 200 at most.',
        },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: TOOL.getEvent,
    description:
      'Read one event: the fields list_events returns, the changed occurrences of a recurring event counted, and its etag for update_event and delete_event.',
    inputSchema: {
      type: 'object',
      properties: { ...calendarArg, ...eventIdArg },
      required: ['event_id'],
    },
  },
  {
    name: TOOL.createEvent,
    description:
      'Create an event. With attendees, the account becomes its organizer and the calendar server may e-mail each attendee an invitation: the call is classified by the zone of the attendees (inside the company domains, on the allowlist, or outside).',
    inputSchema: {
      type: 'object',
      properties: {
        ...calendarArg,
        ...eventFields,
        attendees: addresses('People to invite.'),
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: TOOL.updateEvent,
    description:
      'Change an event the account organizes (or that concerns nobody else); only the fields given change. Changing an event others attend sends them an update: when the event has attendees, give attendees, the full list after the change (get_event lists them), and removed_attendees, the people taken off; the call is classified by their zone and refused if the event concerns somebody else. Invitations organized by somebody else are not changed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...calendarArg,
        ...eventIdArg,
        ...etagArg,
        ...eventFields,
        attendees: addresses('The attendees after the change; omit to change nobody.'),
        removed_attendees: addresses('Attendees taken off the event; they receive a cancellation.'),
      },
      required: ['event_id', 'etag'],
    },
  },
  {
    name: TOOL.deleteEvent,
    description:
      'Delete an event, a recurring series whole. There is no bin. Deleting a meeting sends its attendees a cancellation, and deleting an invitation sends its organizer a decline: give attendees, the organizer and attendees get_event listed, so the call is classified by their zone; it is refused if the event concerns somebody else.',
    inputSchema: {
      type: 'object',
      properties: {
        ...calendarArg,
        ...eventIdArg,
        ...etagArg,
        attendees: addresses('The organizer and attendees of the event, other than this account.'),
      },
      required: ['event_id', 'etag'],
    },
  },
];
