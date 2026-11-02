/**
 * Execution and discovery of `google-calendar` against a mock of Google's
 * Calendar REST API v3: what leaves (the Bearer, the method, the path with
 * the calendar id percent-encoded, the query, the body built from what the
 * reader returned), what comes back, the gateway's own `list_calendars`, the
 * two-step tools (`update_event` with guests, `respond_to_event`),
 * `suggest_time` over freeBusy, and the calendars discovery keeps.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamProtocolError,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  CALENDAR_API_REFUSED,
  calendarsIn,
  discoverGoogleCalendarResources,
  executeGoogleCalendar,
  mergedAttendees,
  resourcesOf,
} from '../../src/execute.ts';
import { PROVIDER_ID, SCOPES, TOOL } from '../../src/identity.ts';
import {
  EVENT,
  EVENT_GET,
  PRIMARY_ID,
  TEAM,
  TEAM_ID,
  TOKEN,
  api,
  context,
  primary,
  requestOf,
} from './fixtures.ts';

const PRIMARY_EVENTS = `/calendars/${encodeURIComponent(PRIMARY_ID)}/events`;
const TEAM_EVENTS = `/calendars/${encodeURIComponent(TEAM_ID)}/events`;

interface Suggestion {
  readonly freeSlots: readonly unknown[];
  readonly availabilityUnknown?: readonly string[];
}

function suggestionOf(result: Parameters<typeof textOf>[0]): Suggestion {
  return JSON.parse(textOf(result)) as Suggestion;
}

function textOf(result: { readonly content: readonly { type: string; text?: string }[] }): string {
  const [first] = result.content;
  return first?.type === 'text' ? (first.text ?? '') : '';
}

describe('reads', () => {
  test('list_events: the calendar id in the path, expanded and ordered by start, the page bounded', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { items: [] } }]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.listEvents, {
      calendarId: TEAM,
      timeMin: '2026-11-03T00:00:00Z',
      q: 'review',
    });
    expect(JSON.parse(textOf(result))).toEqual({ items: [] });
    const [call] = fetch.calls;
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.url.startsWith(api(`${TEAM_EVENTS}?`))).toBe(true);
    expect(requestOf(call!).query).toEqual({
      timeMin: '2026-11-03T00:00:00Z',
      q: 'review',
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
  });

  test('list_events with singleEvents false sends no order unless one is given', async () => {
    const fetch = mockFetch([{ url: () => true, body: { items: [] } }]);
    await executeGoogleCalendar(context(fetch), TOOL.listEvents, {
      singleEvents: false,
      orderBy: 'updated',
    });
    await executeGoogleCalendar(context(fetch), TOOL.listEvents, { singleEvents: false });
    expect(requestOf(fetch.calls[0]!).query).toMatchObject({
      singleEvents: 'false',
      orderBy: 'updated',
    });
    expect(requestOf(fetch.calls[1]!).query.orderBy).toBeUndefined();
  });

  test('search_events honours calendarId (the primary calendar when omitted)', async () => {
    const fetch = mockFetch([{ url: () => true, body: { items: [] } }]);
    await executeGoogleCalendar(context(fetch), TOOL.searchEvents, { q: 'x', calendarId: TEAM });
    await executeGoogleCalendar(context(fetch), TOOL.searchEvents, { q: 'x' });
    expect(fetch.calls.map((c) => requestOf(c).path)).toEqual([TEAM_EVENTS, PRIMARY_EVENTS]);
    expect(requestOf(fetch.calls[0]!).query).toMatchObject({ q: 'x', singleEvents: 'true' });
  });

  test('get_event reads one event', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { id: EVENT } }]);
    await executeGoogleCalendar(context(fetch), TOOL.getEvent, { eventId: EVENT });
    expect(requestOf(fetch.calls[0]!)).toEqual({
      method: 'GET',
      path: `${PRIMARY_EVENTS}/${EVENT}`,
      query: {},
    });
  });

  test('list_calendars is answered by the gateway, without a request', async () => {
    const fetch = mockFetch([]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.listCalendars, {});
    expect(fetch.calls).toHaveLength(0);
    expect(JSON.parse(textOf(result))).toEqual({
      calendars: [
        {
          calendar: 'alice~acme.example',
          id: 'alice@acme.example',
          name: 'Alice',
          primary: true,
          accessRole: 'owner',
        },
        { calendar: TEAM, id: TEAM_ID, name: 'Team', primary: false, accessRole: 'writer' },
      ],
    });
  });
});

describe('writes', () => {
  test('create_event: start and end objects, attendees lower-cased, sendUpdates all by default', async () => {
    const fetch = mockFetch([{ method: 'POST', url: () => true, body: { id: EVENT } }]);
    await executeGoogleCalendar(context(fetch), TOOL.createEvent, {
      summary: 'Sync',
      startTime: '2026-11-03T10:00:00+01:00',
      endTime: '2026-11-03T11:00:00+01:00',
      timeZone: 'Europe/Paris',
      attendees: [{ email: 'Bob@Acme.Example', optional: true }],
    });
    const [call] = fetch.calls;
    expect(requestOf(call!)).toMatchObject({ path: PRIMARY_EVENTS, query: { sendUpdates: 'all' } });
    expect(call?.json).toEqual({
      summary: 'Sync',
      start: { dateTime: '2026-11-03T10:00:00+01:00', timeZone: 'Europe/Paris' },
      end: { dateTime: '2026-11-03T11:00:00+01:00', timeZone: 'Europe/Paris' },
      attendees: [{ email: 'bob@acme.example', optional: true }],
    });
  });

  test('create_event: an all-day event takes dates; a Meet link asks conferenceDataVersion=1', async () => {
    const fetch = mockFetch([{ method: 'POST', url: () => true, body: { id: EVENT } }]);
    await executeGoogleCalendar(context(fetch), TOOL.createEvent, {
      summary: 'Off',
      startTime: '2026-11-03',
      endTime: '2026-11-04',
      allDay: true,
      addGoogleMeet: true,
      sendUpdates: 'none',
    });
    const [call] = fetch.calls;
    expect(requestOf(call!).query).toEqual({ sendUpdates: 'none', conferenceDataVersion: '1' });
    expect(call?.json).toMatchObject({
      start: { date: '2026-11-03' },
      end: { date: '2026-11-04' },
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
  });

  test('update_event without guests: one PATCH of the fields given, the other time form cleared', async () => {
    const fetch = mockFetch([{ method: 'PATCH', url: () => true, body: { id: EVENT } }]);
    await executeGoogleCalendar(context(fetch), TOOL.updateEvent, {
      eventId: EVENT,
      calendarId: TEAM,
      startTime: '2026-11-03T10:00:00Z',
      endTime: '2026-11-03T11:00:00Z',
      sendUpdates: 'externalOnly',
    });
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(requestOf(call!)).toEqual({
      method: 'PATCH',
      path: `${TEAM_EVENTS}/${EVENT}`,
      query: { sendUpdates: 'externalOnly' },
    });
    expect(call?.json).toEqual({
      start: { dateTime: '2026-11-03T10:00:00Z', date: null },
      end: { dateTime: '2026-11-03T11:00:00Z', date: null },
    });
  });

  test('update_event with guests: the event is read, its list merged, then patched', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: {
          id: EVENT,
          attendees: [
            { email: PRIMARY_ID, self: true, organizer: true, responseStatus: 'accepted' },
            { email: 'old@acme.example', responseStatus: 'needsAction' },
          ],
        },
      },
      { method: 'PATCH', url: () => true, body: { id: EVENT } },
    ]);
    await executeGoogleCalendar(context(fetch), TOOL.updateEvent, {
      eventId: EVENT,
      addedAttendees: [{ email: 'new@customer.example' }],
      removedAttendeeEmails: ['OLD@acme.example'],
    });
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(fetch.calls[1]?.json).toEqual({
      attendees: [
        { email: PRIMARY_ID, responseStatus: 'accepted' },
        { email: 'new@customer.example' },
      ],
    });
    expect(requestOf(fetch.calls[1]!).query).toEqual({ sendUpdates: 'all' });
  });

  test('update_event with guests on an event whose list Google shortened is refused, nothing patched', async () => {
    const fetch = mockFetch([EVENT_GET]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.updateEvent, {
      eventId: EVENT,
      addedAttendees: [{ email: 'new@acme.example' }],
    });
    expect(result.isError).toBe(true);
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET']);
  });

  test('delete_event: DELETE with sendUpdates; the empty answer becomes a confirmation', async () => {
    const fetch = mockFetch([{ method: 'DELETE', url: () => true, status: 204 }]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.deleteEvent, {
      eventId: EVENT,
    });
    expect(requestOf(fetch.calls[0]!)).toEqual({
      method: 'DELETE',
      path: `${PRIMARY_EVENTS}/${EVENT}`,
      query: { sendUpdates: 'all' },
    });
    expect(JSON.parse(textOf(result))).toEqual({ deleted: true, eventId: EVENT });
  });

  test('respond_to_event: read with maxAttendees=1, then patch only this account’s entry, nobody emailed by default', async () => {
    const fetch = mockFetch([EVENT_GET, { method: 'PATCH', url: () => true, body: { id: EVENT } }]);
    await executeGoogleCalendar(context(fetch), TOOL.respondToEvent, {
      eventId: EVENT,
      responseStatus: 'tentative',
      responseComment: 'Maybe late',
    });
    expect(fetch.calls.map((c) => requestOf(c))).toEqual([
      { method: 'GET', path: `${PRIMARY_EVENTS}/${EVENT}`, query: { maxAttendees: '1' } },
      { method: 'PATCH', path: `${PRIMARY_EVENTS}/${EVENT}`, query: { sendUpdates: 'none' } },
    ]);
    expect(fetch.calls[1]?.json).toEqual({
      attendeesOmitted: true,
      attendees: [{ email: PRIMARY_ID, responseStatus: 'tentative', comment: 'Maybe late' }],
    });
  });

  test('respond_to_event on an event without this account among the guests is refused', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: { id: EVENT, attendees: [{ email: 'x@y.example' }] },
      },
    ]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.respondToEvent, {
      eventId: EVENT,
      responseStatus: 'accepted',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a guest of the event/);
    expect(fetch.calls).toHaveLength(1);
  });

  test('mergedAttendees keeps the writable fields, drops the removed, adds the new once', () => {
    expect(
      mergedAttendees(
        [
          { email: 'A@x.example', self: true, organizer: true, comment: 'hi' },
          { email: 'b@x.example' },
        ],
        [{ email: 'a@x.example' }, { email: 'c@x.example' }],
        ['b@x.example'],
      ),
    ).toEqual([{ email: 'A@x.example', comment: 'hi' }, { email: 'c@x.example' }]);
  });
});

describe('suggest_time', () => {
  test('freeBusy for this account and the people named; the free slots of the window', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: api('/freeBusy'),
        body: {
          kind: 'calendar#freeBusy',
          calendars: {
            [PRIMARY_ID]: {
              busy: [{ start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' }],
            },
            'bob@acme.example': {
              busy: [{ start: '2026-11-03T09:30:00Z', end: '2026-11-03T11:00:00Z' }],
            },
            'zoe@elsewhere.example': { errors: [{ domain: 'global', reason: 'notFound' }] },
          },
        },
      },
    ]);
    const result = await executeGoogleCalendar(context(fetch), TOOL.suggestTime, {
      attendeeEmails: ['Bob@acme.example', 'zoe@elsewhere.example'],
      timeMin: '2026-11-03T08:00:00Z',
      timeMax: '2026-11-03T12:00:00Z',
      durationMinutes: 45,
    });
    expect(fetch.calls[0]?.json).toEqual({
      timeMin: '2026-11-03T08:00:00Z',
      timeMax: '2026-11-03T12:00:00Z',
      items: [{ id: PRIMARY_ID }, { id: 'bob@acme.example' }, { id: 'zoe@elsewhere.example' }],
    });
    const answer = suggestionOf(result);
    expect(answer.freeSlots).toEqual([
      { start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T09:00:00.000Z' },
      { start: '2026-11-03T11:00:00.000Z', end: '2026-11-03T12:00:00.000Z' },
    ]);
    expect(answer.availabilityUnknown).toEqual(['zoe@elsewhere.example']);
  });

  test('without the account’s address in the mission, the account is asked as primary', async () => {
    const fetch = mockFetch([{ method: 'POST', url: () => true, body: { calendars: {} } }]);
    const result = await executeGoogleCalendar(context(fetch, []), TOOL.suggestTime, {
      attendeeEmails: ['bob@acme.example'],
      timeMin: '2026-11-03T08:00:00Z',
      timeMax: '2026-11-03T09:00:00Z',
    });
    expect(fetch.calls[0]?.json).toMatchObject({
      items: [{ id: 'primary' }, { id: 'bob@acme.example' }],
    });
    expect(suggestionOf(result).availabilityUnknown).toEqual(['this account', 'bob@acme.example']);
  });
});

describe('failures', () => {
  test('a refused call sends nothing; 401 and 403 are auth errors; 404 and 410 are HTTP errors', async () => {
    const none = mockFetch([]);
    const refused = await executeGoogleCalendar(context(none), TOOL.getEvent, { eventId: '../x' });
    expect(refused.isError).toBe(true);
    expect(none.calls).toHaveLength(0);

    for (const [status, type] of [
      [401, UpstreamAuthError],
      [403, UpstreamAuthError],
      [404, UpstreamHttpError],
      [410, UpstreamHttpError],
      [429, UpstreamHttpError],
    ] as const) {
      const fetch = mockFetch([
        { url: () => true, status, body: { error: { code: status, message: 'x' } } },
      ]);
      await expect(
        executeGoogleCalendar(context(fetch), TOOL.getEvent, { eventId: EVENT }),
      ).rejects.toBeInstanceOf(type);
    }
  });

  test('an answer that is not JSON is a protocol failure', async () => {
    const fetch = mockFetch([{ url: () => true, body: 'not json' }]);
    await expect(
      executeGoogleCalendar(context(fetch), TOOL.getEvent, { eventId: EVENT }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});

describe('discovery', () => {
  test('reads calendarList page by page, leaves Google’s subscribed calendars out, seeds the zoning', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (url) => url.startsWith(api('/users/me/calendarList')),
        respond: (call) =>
          requestOf(call).query.pageToken === 'p2'
            ? { items: [{ id: TEAM_ID, summary: 'Team', accessRole: 'writer' }] }
            : {
                items: [
                  { id: PRIMARY_ID, summary: 'Alice', primary: true, accessRole: 'owner' },
                  { id: 'en.french#holiday@group.v.calendar.google.com', summary: 'Holidays' },
                ],
                nextPageToken: 'p2',
              },
      },
    ]);
    const resources = await discoverGoogleCalendarResources(context(fetch));
    expect(requestOf(fetch.calls[0]!).query).toEqual({ maxResults: '250' });
    expect(fetch.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(resources).toEqual([
      {
        provider: PROVIDER_ID,
        ref: 'alice~acme.example',
        displayName: 'Alice',
        metadata: {
          primary: true,
          access_role: 'owner',
          account_email: 'alice@acme.example',
          internal_domains: ['acme.example'],
        },
      },
      {
        provider: PROVIDER_ID,
        ref: TEAM,
        displayName: 'Team',
        metadata: {
          primary: false,
          access_role: 'writer',
          account_email: 'alice@acme.example',
          internal_domains: ['acme.example'],
        },
      },
    ]);
  });

  test('a consumer account is not its own company: no internal domain is seeded', () => {
    const [cal] = resourcesOf([
      { id: 'alice@gmail.com', name: 'Alice', primary: true, accessRole: 'owner' },
    ]);
    expect(cal?.metadata?.internal_domains).toEqual([]);
  });

  test('reads nothing but calendar entries of the grammar', () => {
    expect(
      calendarsIn(['alice@acme.example', { id: 'x', summary: 'X' }, { id: 'a@b.example' }, null]),
    ).toEqual([]);
    expect(calendarsIn([{ id: 'a@b.example', summary: 'A', deleted: true }])).toEqual([]);
  });

  test('a 403 at discovery is a refusal the person can read; a rate limit is not', async () => {
    const forbidden = mockFetch([{ url: () => true, status: 403, body: { error: { code: 403 } } }]);
    const refusal = discoverGoogleCalendarResources(context(forbidden));
    await expect(refusal).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(refusal).rejects.toThrow(CALENDAR_API_REFUSED);

    const limited = mockFetch([
      {
        url: () => true,
        status: 403,
        body: { error: { errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } },
      },
    ]);
    const failure = discoverGoogleCalendarResources(context(limited));
    await expect(failure).rejects.toBeInstanceOf(UpstreamHttpError);
  });

  test('an answer that is not a calendar list is a protocol failure', async () => {
    const fetch = mockFetch([{ url: () => true, body: { items: 'none' } }]);
    await expect(discoverGoogleCalendarResources(context(fetch))).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
  });

  test('a token Google granted fewer scopes than asked is refused before any request', async () => {
    const fetch = mockFetch([]);
    const granted = [SCOPES.events];
    const refusal = discoverGoogleCalendarResources(context(fetch, [primary], granted));
    await expect(refusal).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(refusal).rejects.toThrow(/missing: see the list of calendars\)/);
    expect(fetch.calls).toHaveLength(0);
  });
});
