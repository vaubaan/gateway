/**
 * Execution of the calendar tools and discovery against a mock of Microsoft
 * Graph: events addressed under the calendar the call names, times in UTC,
 * the attendees merged on an update, the answer to an invitation,
 * `suggest_time` over getSchedule, and the mailbox discovery keeps.
 */
import { describe, expect, test } from 'vitest';

import { CredentialRefusal, UpstreamHttpError } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { mergedAttendees } from '../../src/calendar.ts';
import {
  NO_ADDRESS,
  PROFILE_REFUSED,
  discoverOutlookResources,
  executeOutlook,
  mailboxResource,
} from '../../src/execute.ts';
import { SERVICE_ID, TOOL } from '../../src/identity.ts';
import { ACCOUNT, CALENDAR, EVENT, context, mailbox, requestOf } from './fixtures.ts';

function json(result: { readonly content: readonly { type: string; text?: string }[] }): unknown {
  const [first] = result.content;
  return JSON.parse(first?.type === 'text' ? (first.text ?? '') : 'null') as unknown;
}

const range = { start: '2026-11-05T08:00:00+01:00', end: '2026-11-05T18:00:00Z' };

describe('reads', () => {
  test('list_calendars', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { value: [] } }]);
    await executeOutlook(context(fetch), TOOL.listCalendars, {});
    expect(requestOf(fetch.calls[0]!)).toMatchObject({
      path: '/me/calendars',
      query: { $top: '100', $select: 'id,name,isDefaultCalendar,canEdit,owner' },
    });
  });

  test('list_events: the calendar view of the default calendar or a named one, UTC, ordered', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { value: [] } }]);
    await executeOutlook(context(fetch), TOOL.listEvents, range);
    await executeOutlook(context(fetch), TOOL.listEvents, { ...range, calendar: CALENDAR, top: 5 });
    expect(requestOf(fetch.calls[0]!)).toMatchObject({
      path: '/me/calendar/calendarView',
      query: {
        startDateTime: '2026-11-05T07:00:00.000Z',
        endDateTime: '2026-11-05T18:00:00.000Z',
        $top: '50',
        $orderby: 'start/dateTime',
      },
    });
    expect(fetch.calls[0]?.headers.prefer).toBe('IdType="ImmutableId", outlook.timezone="UTC"');
    expect(requestOf(fetch.calls[1]!)).toMatchObject({
      path: `/me/calendars/${CALENDAR}/calendarView`,
      query: { $top: '5' },
    });
  });

  test("search_events: a contains() filter with the quote doubled, or the range's subjects", async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: { value: [{ subject: "Bob's review" }, { subject: 'Lunch' }] },
      },
    ]);
    await executeOutlook(context(fetch), TOOL.searchEvents, { text: "Bob's" });
    expect(requestOf(fetch.calls[0]!)).toMatchObject({
      path: '/me/calendar/events',
      query: { $filter: "contains(subject,'Bob''s')" },
    });
    const result = await executeOutlook(context(fetch), TOOL.searchEvents, {
      text: 'REVIEW',
      ...range,
    });
    expect(requestOf(fetch.calls[1]!).path).toBe('/me/calendar/calendarView');
    expect((json(result) as { value: unknown[] }).value).toEqual([{ subject: "Bob's review" }]);
  });

  test('get_event: under its calendar, never /me/events', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { id: EVENT } }]);
    await executeOutlook(context(fetch), TOOL.getEvent, { event_id: EVENT, calendar: CALENDAR });
    expect(requestOf(fetch.calls[0]!).path).toBe(`/me/calendars/${CALENDAR}/events/${EVENT}`);
  });
});

describe('suggest_time', () => {
  test('getSchedule for the account and the people; busy items subtracted, unknown people named', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: () => true,
        body: {
          value: [
            {
              scheduleId: ACCOUNT,
              scheduleItems: [
                {
                  status: 'busy',
                  start: { dateTime: '2026-11-05T08:00:00.0000000' },
                  end: { dateTime: '2026-11-05T12:00:00.0000000' },
                },
                {
                  status: 'free',
                  start: { dateTime: '2026-11-05T12:00:00' },
                  end: { dateTime: '2026-11-05T18:00:00' },
                },
              ],
            },
            {
              scheduleId: 'bob@contoso.example',
              scheduleItems: [
                {
                  status: 'tentative',
                  start: { dateTime: '2026-11-05T13:00:00' },
                  end: { dateTime: '2026-11-05T14:00:00' },
                },
              ],
            },
            { scheduleId: 'zoe@else.example', error: { message: 'not found' } },
          ],
        },
      },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.suggestTime, {
      attendees: ['Bob@Contoso.example', 'zoe@else.example'],
      start: '2026-11-05T08:00:00Z',
      end: '2026-11-05T18:00:00Z',
      duration_minutes: 60,
      max_suggestions: 5,
    });
    expect(requestOf(fetch.calls[0]!).path).toBe('/me/calendar/getSchedule');
    expect(fetch.calls[0]?.json).toEqual({
      schedules: [ACCOUNT, 'bob@contoso.example', 'zoe@else.example'],
      startTime: { dateTime: '2026-11-05T08:00:00', timeZone: 'UTC' },
      endTime: { dateTime: '2026-11-05T18:00:00', timeZone: 'UTC' },
      availabilityViewInterval: 15,
    });
    expect(json(result)).toMatchObject({
      durationMinutes: 60,
      freeSlots: [
        { start: '2026-11-05T12:00:00.000Z', end: '2026-11-05T13:00:00.000Z' },
        { start: '2026-11-05T14:00:00.000Z', end: '2026-11-05T18:00:00.000Z' },
      ],
      availabilityUnknown: ['zoe@else.example'],
    });
  });
});

describe('writes', () => {
  test('create_event: UTC from an offset, attendees as required, the answer without the body', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: () => true,
        body: { id: EVENT, subject: 'Sync', body: { content: 'agenda' } },
      },
    ]);
    const result = await executeOutlook(context(fetch), TOOL.createEvent, {
      subject: 'Sync',
      start: '2026-11-05T10:00:00+01:00',
      end: '2026-11-05T11:00:00+01:00',
      body: 'Agenda',
      location: 'Room 2',
      attendees: ['Bob@Contoso.example'],
    });
    expect(requestOf(fetch.calls[0]!).path).toBe('/me/calendar/events');
    expect(fetch.calls[0]?.json).toEqual({
      subject: 'Sync',
      body: { contentType: 'text', content: 'Agenda' },
      location: { displayName: 'Room 2' },
      start: { dateTime: '2026-11-05T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-05T10:00:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'bob@contoso.example' }, type: 'required' }],
    });
    expect(json(result)).toEqual({ id: EVENT, subject: 'Sync' });
  });

  test('create_event: local times keep their time zone', async () => {
    const fetch = mockFetch([{ method: 'POST', url: () => true, body: { id: EVENT } }]);
    await executeOutlook(context(fetch), TOOL.createEvent, {
      calendar: CALENDAR,
      subject: 'Focus',
      start: '2026-11-05T10:00',
      end: '2026-11-05T11:30',
      time_zone: 'Romance Standard Time',
    });
    expect(requestOf(fetch.calls[0]!).path).toBe(`/me/calendars/${CALENDAR}/events`);
    expect(fetch.calls[0]?.json).toMatchObject({
      start: { dateTime: '2026-11-05T10:00:00', timeZone: 'Romance Standard Time' },
      end: { dateTime: '2026-11-05T11:30:00', timeZone: 'Romance Standard Time' },
      attendees: [],
    });
  });

  test('update_event with attendees: read, merged, patched', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: {
          attendees: [
            { emailAddress: { address: 'Bob@Contoso.example', name: 'Bob' }, type: 'required' },
            { emailAddress: { address: 'carol@customer.example' }, type: 'optional' },
          ],
        },
      },
      { method: 'PATCH', url: () => true, body: { id: EVENT } },
    ]);
    await executeOutlook(context(fetch), TOOL.updateEvent, {
      event_id: EVENT,
      added_attendees: ['dan@partner.example', 'bob@contoso.example'],
      removed_attendee_emails: ['carol@customer.example'],
    });
    expect(fetch.calls.map((c) => `${c.method} ${requestOf(c).path}`)).toEqual([
      `GET /me/calendar/events/${EVENT}`,
      `PATCH /me/calendar/events/${EVENT}`,
    ]);
    expect(fetch.calls[1]?.json).toEqual({
      attendees: [
        { emailAddress: { address: 'Bob@Contoso.example' }, type: 'required' },
        { emailAddress: { address: 'dan@partner.example' }, type: 'required' },
      ],
    });
  });

  test('update_event without attendees: one PATCH of the fields given', async () => {
    const fetch = mockFetch([{ method: 'PATCH', url: () => true, body: { id: EVENT } }]);
    await executeOutlook(context(fetch), TOOL.updateEvent, { event_id: EVENT, subject: 'Moved' });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.json).toEqual({ subject: 'Moved' });
  });

  test('delete_event and respond_to_event', async () => {
    const fetch = mockFetch([
      { method: 'DELETE', url: () => true, status: 204 },
      { method: 'POST', url: () => true, status: 202 },
    ]);
    const deleted = await executeOutlook(context(fetch), TOOL.deleteEvent, { event_id: EVENT });
    expect(json(deleted)).toEqual({ deleted: true, event_id: EVENT });
    const answered = await executeOutlook(context(fetch), TOOL.respondToEvent, {
      event_id: EVENT,
      response: 'tentative',
      comment: 'Maybe',
    });
    expect(requestOf(fetch.calls[1]!).path).toBe(`/me/calendar/events/${EVENT}/tentativelyAccept`);
    expect(fetch.calls[1]?.json).toEqual({ comment: 'Maybe', sendResponse: false });
    expect(json(answered)).toEqual({
      event_id: EVENT,
      response: 'tentative',
      sent_to_organizer: false,
    });
  });

  test('mergedAttendees keeps the current ones, drops the removed, adds the new once', () => {
    expect(
      mergedAttendees(
        [{ emailAddress: { address: 'A@x.example' }, type: 'optional' }],
        ['a@x.example', 'b@x.example'],
        [],
      ),
    ).toEqual([
      { emailAddress: { address: 'A@x.example' }, type: 'optional' },
      { emailAddress: { address: 'b@x.example' }, type: 'required' },
    ]);
  });

  test('a service failure is thrown', async () => {
    const fetch = mockFetch([
      { url: () => true, status: 404, body: { error: { code: 'ErrorItemNotFound' } } },
    ]);
    await expect(
      executeOutlook(context(fetch), TOOL.deleteEvent, { event_id: EVENT }),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
  });
});

describe('discovery', () => {
  test('one mailbox from /me: the address as ref, its domain internal', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: () => true,
        body: {
          id: 'u1',
          displayName: 'Alice Martin',
          mail: 'Alice@Contoso.example',
          userPrincipalName: 'alice@contoso.onmicrosoft.com',
        },
      },
    ]);
    const resources = await discoverOutlookResources(context(fetch));
    expect(requestOf(fetch.calls[0]!)).toMatchObject({
      path: '/me',
      query: { $select: 'id,displayName,mail,userPrincipalName' },
    });
    expect(resources).toEqual([
      {
        service: SERVICE_ID,
        ref: 'alice~contoso.example',
        displayName: 'Alice Martin <alice@contoso.example>',
        metadata: {
          account_email: 'alice@contoso.example',
          internal_domains: ['contoso.example'],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      },
    ]);
  });

  test('a personal account: mail null, the userPrincipalName, a consumer domain not internal', () => {
    expect(
      mailboxResource({ mail: null, userPrincipalName: 'bob@outlook.com', displayName: '' }),
    ).toMatchObject({
      ref: 'bob~outlook.com',
      displayName: 'bob@outlook.com',
      metadata: { internal_domains: [] },
    });
    expect(mailboxResource({ mail: 'x@gmail.com' }).metadata).toMatchObject({
      internal_domains: [],
    });
  });

  test('no address, a refused profile, missing permissions: refused in the gateway’s words', async () => {
    expect(() => mailboxResource({ mail: 'nobody', userPrincipalName: 'x' })).toThrow(NO_ADDRESS);
    const forbidden = mockFetch([
      { url: () => true, status: 403, body: { error: { code: 'ErrorAccessDenied' } } },
    ]);
    await expect(discoverOutlookResources(context(forbidden))).rejects.toThrow(PROFILE_REFUSED);
    const none = mockFetch([]);
    await expect(
      discoverOutlookResources(context(none, [mailbox], ['openid', 'User.Read'])),
    ).rejects.toBeInstanceOf(CredentialRefusal);
    expect(none.calls).toHaveLength(0);
  });

  test('a display name is bounded and printable', () => {
    const r = mailboxResource({ mail: ACCOUNT, displayName: `A\u0007${'b'.repeat(300)}` });
    expect(r.displayName.startsWith('A b')).toBe(true);
    expect(r.displayName.length).toBeLessThan(150);
  });
});
