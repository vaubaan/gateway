/**
 * The classifier of `google-calendar`, branch by branch: the calendar of the
 * mission, the event id, the zones of the people invited (inside or outside
 * the company, by the calendar's `internal_domains`), the guests Google
 * emails on a change or a deletion, and every refusal.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice } from '@vaubaan/plugin-sdk';

import { classifyGoogleCalendar } from '../../src/classify.ts';
import { TOOL } from '../../src/identity.ts';
import { EVENT, PRIMARY, PRIMARY_ID, TEAM, primary, team } from './fixtures.ts';

const at = { startTime: '2026-11-03T10:00:00Z', endTime: '2026-11-03T11:00:00Z' };
const range = { timeMin: '2026-11-03T08:00:00Z', timeMax: '2026-11-03T18:00:00Z' };

function slices(tool: string, args: Record<string, unknown>, resources = [primary, team]) {
  const out = classifyGoogleCalendar(tool, args, resources);
  if ('denied' in out) throw new Error(`denied: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

function denied(tool: string, args: Record<string, unknown>, resources = [primary, team]) {
  const out = classifyGoogleCalendar(tool, args, resources);
  if (!('denied' in out)) throw new Error('expected a refusal');
  return out.denied;
}

describe('reads', () => {
  test('list_calendars names the mission’s calendars', () => {
    expect(slices(TOOL.listCalendars, {})).toEqual([
      `google-calendar.calendar[${PRIMARY},${TEAM}].R`,
    ]);
  });

  test('list_events on a named calendar, by ref or by id; omitted, the primary one', () => {
    expect(slices(TOOL.listEvents, { calendarId: TEAM })).toEqual([
      `google-calendar.calendar[${TEAM}].event[*].R`,
    ]);
    expect(slices(TOOL.listEvents, { calendarId: PRIMARY_ID })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[*].R`,
    ]);
    expect(slices(TOOL.listEvents, {})).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[*].R`,
    ]);
    expect(slices(TOOL.listEvents, { calendarId: 'primary' })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[*].R`,
    ]);
  });

  test('get_event names the event; search_events the calendar named, the primary one when omitted', () => {
    expect(slices(TOOL.getEvent, { eventId: EVENT })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[${EVENT}].R`,
    ]);
    expect(slices(TOOL.searchEvents, { q: 'review' })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[*].R`,
    ]);
    expect(slices(TOOL.searchEvents, { q: 'review', calendarId: TEAM })).toEqual([
      `google-calendar.calendar[${TEAM}].event[*].R`,
    ]);
  });

  test('suggest_time reads free/busy, whoever is asked about', () => {
    expect(
      slices(TOOL.suggestTime, { attendeeEmails: ['zoe@elsewhere.example'], ...range }),
    ).toEqual(['google-calendar.free-busy.R']);
  });
});

describe('writes and who they reach', () => {
  test('an event without guests is a creation only', () => {
    expect(slices(TOOL.createEvent, { summary: 'Focus', ...at })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event.W`,
    ]);
  });

  test('inviting oneself reaches nobody; colleagues and rooms are internal; anyone else external', () => {
    expect(
      slices(TOOL.createEvent, { summary: 'x', ...at, attendees: [{ email: PRIMARY_ID }] }),
    ).toEqual([`google-calendar.calendar[${PRIMARY}].event.W`]);
    expect(
      slices(TOOL.createEvent, {
        summary: 'x',
        ...at,
        attendees: [
          { email: 'Bob@ACME.example' },
          { email: 'c_1888abc@resource.calendar.google.com', optional: true },
        ],
      }),
    ).toEqual([
      `google-calendar.calendar[${PRIMARY}].event.W`,
      `google-calendar.calendar[${PRIMARY}].guests[internal].W`,
    ]);
    expect(
      slices(TOOL.createEvent, {
        summary: 'x',
        ...at,
        attendees: [{ email: 'bob@acme.example' }, { email: 'carol@customer.example' }],
      }),
    ).toEqual([
      `google-calendar.calendar[${PRIMARY}].event.W`,
      `google-calendar.calendar[${PRIMARY}].guests[external].W`,
      `google-calendar.calendar[${PRIMARY}].guests[internal].W`,
    ]);
  });

  test('a calendar without internal domains takes every other person as external', () => {
    const bare = { ...primary, metadata: { primary: true, account_email: PRIMARY_ID } };
    expect(
      slices(
        TOOL.createEvent,
        { summary: 'x', ...at, attendees: [{ email: 'bob@acme.example' }] },
        [bare],
      ),
    ).toContain(`google-calendar.calendar[${PRIMARY}].guests[external].W`);
  });

  test('a change lets Google email the guests unless sendUpdates is none', () => {
    expect(slices(TOOL.updateEvent, { eventId: EVENT, summary: 'Moved' })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[${EVENT}].W`,
      `google-calendar.calendar[${PRIMARY}].event[${EVENT}].notify.W`,
    ]);
    expect(
      slices(TOOL.updateEvent, {
        eventId: EVENT,
        sendUpdates: 'none',
        addedAttendees: [{ email: 'dan@vendor.example' }],
      }),
    ).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[${EVENT}].W`,
      `google-calendar.calendar[${PRIMARY}].guests[external].W`,
    ]);
    expect(slices(TOOL.updateEvent, { eventId: EVENT, sendUpdates: 'externalOnly' })).toContain(
      `google-calendar.calendar[${PRIMARY}].event[${EVENT}].notify.W`,
    );
  });

  test('a deletion and an answer have their own verbs', () => {
    expect(slices(TOOL.deleteEvent, { eventId: EVENT, calendarId: TEAM })).toEqual([
      `google-calendar.calendar[${TEAM}].event[${EVENT}].delete.W`,
      `google-calendar.calendar[${TEAM}].event[${EVENT}].notify.W`,
    ]);
    expect(slices(TOOL.respondToEvent, { eventId: EVENT, responseStatus: 'declined' })).toEqual([
      `google-calendar.calendar[${PRIMARY}].event[${EVENT}].response.W`,
    ]);
  });
});

describe('refusals', () => {
  test('a calendar outside the mission, malformed, or a primary the mission lacks', () => {
    expect(denied(TOOL.listEvents, { calendarId: 'bob@acme.example' })).toMatch(
      /not a calendar of this mission/,
    );
    expect(
      denied(TOOL.listEvents, { calendarId: 'en.french#holiday@group.v.calendar.google.com' }),
    ).toMatch(/expected a calendar ref/);
    expect(denied(TOOL.listEvents, {}, [team])).toMatch(/primary calendar is not in this mission/);
    expect(denied(TOOL.searchEvents, { q: 'x' }, [team])).toMatch(/primary calendar/);
    expect(denied(TOOL.listCalendars, {}, [])).toBe('no Google calendar in this mission');
  });

  test('an event id outside its grammar', () => {
    expect(denied(TOOL.getEvent, { eventId: '../x' })).toMatch(/expected a Google event id/);
    expect(denied(TOOL.getEvent, {})).toMatch(/eventId: required/);
  });

  test('an attendee that is not exactly one address, or carries other fields', () => {
    for (const email of ['bob', 'a@b.example, c@d.example', 'Bob <bob@acme.example>', 7]) {
      expect(denied(TOOL.createEvent, { summary: 'x', ...at, attendees: [{ email }] })).toMatch(
        /attendees\[0\]\.email: expected exactly one email address/,
      );
    }
    expect(
      denied(TOOL.createEvent, {
        summary: 'x',
        ...at,
        attendees: [{ email: 'bob@acme.example', responseStatus: 'accepted' }],
      }),
    ).toMatch(/responseStatus not accepted/);
    expect(
      denied(TOOL.createEvent, { summary: 'x', ...at, attendees: 'bob@acme.example' }),
    ).toMatch(/expected a list of attendees/);
  });

  test('undeclared, MCP-only and ill-typed arguments; an unknown tool', () => {
    expect(
      denied(TOOL.createEvent, { summary: 'x', ...at, attendeeEmails: ['x@y.example'] }),
    ).toMatch(/attendeeEmails/);
    expect(denied(TOOL.updateEvent, { eventId: EVENT, notificationLevel: 'NONE' })).toMatch(
      /notificationLevel/,
    );
    expect(denied(TOOL.listCalendars, { pageSize: 10 })).toMatch(/pageSize/);
    expect(denied(TOOL.respondToEvent, { eventId: EVENT, responseStatus: 'maybe' })).toMatch(
      /expected one of accepted, declined, tentative/,
    );
    expect(denied(TOOL.deleteEvent, { eventId: EVENT, sendUpdates: 'NONE' })).toMatch(
      /expected one of all, externalOnly, none/,
    );
    expect(denied(TOOL.listEvents, { maxResults: '10' })).toMatch(/maxResults: expected integer/);
    expect(denied(TOOL.listEvents, { maxResults: 251 })).toMatch(/maxResults: at most 250/);
    expect(denied(TOOL.createEvent, { summary: 'x', ...at, recurrence: [7] })).toMatch(
      /recurrence\[0\]: expected string/,
    );
    expect(denied('google_calendar__delete_calendar', {})).toMatch(/unknown tool/);
  });

  test('arguments that go together', () => {
    expect(denied(TOOL.listEvents, { singleEvents: false, orderBy: 'startTime' })).toMatch(
      /startTime needs singleEvents/,
    );
    expect(denied(TOOL.updateEvent, { eventId: EVENT, startTime: at.startTime })).toMatch(
      /give both or neither/,
    );
    expect(denied(TOOL.updateEvent, { eventId: EVENT, allDay: true })).toMatch(/allDay/);
    expect(denied(TOOL.createEvent, { summary: 'x', ...at, allDay: true })).toMatch(/dates/);
    expect(
      denied(TOOL.suggestTime, { attendeeEmails: ['a@b.example'], timeMin: 'today', timeMax: 'x' }),
    ).toMatch(/RFC3339/);
    expect(
      denied(TOOL.suggestTime, {
        attendeeEmails: ['a@b.example'],
        timeMin: range.timeMax,
        timeMax: range.timeMin,
      }),
    ).toMatch(/after timeMin/);
    expect(denied(TOOL.suggestTime, { attendeeEmails: [], ...range })).toMatch(/1 to 49/);
  });
});
