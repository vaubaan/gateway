/**
 * Execution of the `caldav` tools against the fake server : the requests
 * sent (method, URL, headers, body), the JSON returned, the refusals sent
 * before any write, and the service failures thrown.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import { UpstreamAuthError, UpstreamHttpError, type McpToolResult } from '@vaubaan/plugin-sdk';
import { refusalText } from '@vaubaan/plugin-sdk/testing';

import { createCaldavPlugin } from '../../src/index.ts';
import { TOOL } from '../../src/identity.ts';
import { plainServer, type FakeCaldavServer } from './fake-caldav.ts';
import { calendarResource, eventIcs, execCtx, home, work } from './fixtures.ts';

const plugin = createCaldavPlugin({
  now: () => new Date('2026-10-27T08:00:00Z'),
  uuid: () => '0f8c2d1e-0000-4000-8000-00000000abcd',
});
const WORK = '/dav/calendars/ada/work/';

const json = (result: McpToolResult): Record<string, unknown> => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
};

let server: FakeCaldavServer;
beforeEach(() => {
  server = plainServer();
});

const run = (tool: string, args: Record<string, unknown>, resources = [work]) =>
  plugin.execute(execCtx(server, resources), tool, args);

const writes = () => server.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE');

describe('list_calendars', () => {
  test('the calendars of the mission, read live', async () => {
    const out = json(await run(TOOL.listCalendars, {}, [work, home]));
    expect(out.calendars).toEqual([
      { calendar: 'work', name: 'Work', description: 'Team meetings' },
      { calendar: 'home', name: 'Home', description: null },
    ]);
    expect(
      server.requests.map((r) => `${r.method} ${r.headers.depth} ${new URL(r.url).pathname}`),
    ).toEqual([`PROPFIND 0 ${WORK}`, 'PROPFIND 0 /dav/calendars/ada/home/']);
  });

  test('a resource whose address is not on the server of the credential is declined, nothing sent', async () => {
    const stray = calendarResource('work', 'https://evil.example/dav/calendars/ada/work/');
    expect(await refusalText(run(TOOL.listCalendars, {}, [stray]))).toMatch(
      /has no address on cal\.example\.com/,
    );
    expect(server.requests).toEqual([]);
  });

  test('a resource whose ref is not its address is declined', async () => {
    const swapped = calendarResource('work', 'https://cal.example.com/dav/calendars/ada/home/');
    expect(await refusalText(run(TOOL.listCalendars, {}, [swapped]))).toMatch(/has no address/);
    expect(server.requests).toEqual([]);
  });
});

describe('list_events', () => {
  test('a calendar-query REPORT with the UTC time range ; events as JSON, oldest first', async () => {
    server.put(
      WORK,
      'late.ics',
      eventIcs({
        uid: 'late',
        start: '20261029T090000Z',
        end: '20261029T100000Z',
        summary: 'Later',
      }),
    );
    server.put(WORK, 'early.ics', eventIcs({ uid: 'early', summary: 'Earlier' }));
    server.put(
      WORK,
      'out.ics',
      eventIcs({ uid: 'out', start: '20261201T090000Z', end: '20261201T100000Z' }),
    );
    const out = json(
      await run(TOOL.listEvents, { start: '2026-10-26T00:00:00+01:00', end: '2026-11-02' }),
    );
    const report = server.requests[0]!;
    expect(report.method).toBe('REPORT');
    expect(report.headers.depth).toBe('1');
    expect(report.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(report.body).toContain(
      '<c:time-range start="20261025T230000Z" end="20261102T000000Z"/>',
    );
    expect(out.total).toBe(2);
    expect(out.truncated).toBe(false);
    const events = out.events as Record<string, unknown>[];
    expect(events.map((e) => [e.event_id, e.summary, e.uid])).toEqual([
      ['early.ics', 'Earlier', 'early'],
      ['late.ics', 'Later', 'late'],
    ]);
    expect(events[0]).toMatchObject({
      etag: '"e2"',
      start: '2026-10-27T09:00:00Z',
      timezone: 'UTC',
    });
    expect(JSON.stringify(out)).not.toContain('BEGIN:VCALENDAR');
  });

  test('max_results caps the events and says it', async () => {
    for (let i = 1; i <= 3; i += 1) server.put(WORK, `e${i}.ics`, eventIcs({ uid: `u${i}` }));
    const out = json(
      await run(TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02', max_results: 2 }),
    );
    expect((out.events as unknown[]).length).toBe(2);
    expect(out).toMatchObject({ total: 3, truncated: true });
  });

  test('an unreadable object is listed as such, the others still read', async () => {
    server.put(WORK, 'bad.ics', 'BEGIN:VCALENDAR\r\nDTSTART:20261027T090000Z\r\n');
    server.put(WORK, 'good.ics', eventIcs());
    const events = json(await run(TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }))
      .events as Record<string, unknown>[];
    expect(events).toContainEqual({ event_id: 'bad.ics', etag: '"e1"', unreadable: true });
    expect(events.some((e) => e.event_id === 'good.ics')).toBe(true);
  });

  test('an event named outside the id grammar is listed with no event_id', async () => {
    server.put(WORK, 'odd name.ics', eventIcs());
    const events = json(await run(TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }))
      .events as Record<string, unknown>[];
    expect(events[0]!.event_id).toBeNull();
  });

  test('a malformed range is declined before any request', async () => {
    expect(
      await refusalText(run(TOOL.listEvents, { start: '2026-10-26', end: '2028-01-01' })),
    ).toMatch(/366 days/);
    expect(server.requests).toEqual([]);
  });

  test('401 is an UpstreamAuthError, 500 an UpstreamHttpError', async () => {
    const ctx = execCtx(server);
    const bad = {
      ...ctx,
      credential: {
        ...ctx.credential,
        fields: {
          ...(ctx.credential as { fields: Record<string, string> }).fields,
          app_password: 'nope',
        },
      },
    } as typeof ctx;
    await expect(
      plugin.execute(bad, TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
    const failing = {
      ...ctx,
      fetch: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    };
    await expect(
      plugin.execute(failing, TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
  });

  test('an answer that is not a multistatus is a thrown failure', async () => {
    const ctx = {
      ...execCtx(server),
      fetch: (async () => new Response('<html/>', { status: 207 })) as typeof fetch,
    };
    await expect(
      plugin.execute(ctx, TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }),
    ).rejects.toThrow(/not a WebDAV multistatus/);
  });

  test('a document type is refused (no entity expansion)', async () => {
    const body =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><D:multistatus xmlns:D="DAV:"/>';
    const ctx = {
      ...execCtx(server),
      fetch: (async () => new Response(body, { status: 207 })) as typeof fetch,
    };
    await expect(
      plugin.execute(ctx, TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }),
    ).rejects.toThrow(/document type/);
  });

  test('an answer larger than its bound is a thrown failure', async () => {
    const ctx = {
      ...execCtx(server),
      fetch: (async () =>
        new Response('x', {
          status: 207,
          headers: { 'content-length': '999999999' },
        })) as typeof fetch,
    };
    await expect(
      plugin.execute(ctx, TOOL.listEvents, { start: '2026-10-26', end: '2026-11-02' }),
    ).rejects.toThrow(/more than/);
  });
});

describe('get_event', () => {
  test('GET of the event file ; the fields and the etag', async () => {
    server.put(
      WORK,
      'evt-1.ics',
      eventIcs({ organizer: 'ada@example.com', attendees: ['bob@example.com'] }),
    );
    const out = json(await run(TOOL.getEvent, { event_id: 'evt-1.ics' }));
    expect(server.requests[0]).toMatchObject({
      method: 'GET',
      url: `https://cal.example.com${WORK}evt-1.ics`,
    });
    expect(out).toMatchObject({
      calendar: 'work',
      event_id: 'evt-1.ics',
      etag: '"e1"',
      summary: 'Stand-up',
      organizer: { address: 'ada@example.com' },
      attendees: [{ address: 'bob@example.com', name: null, status: 'NEEDS-ACTION' }],
    });
  });

  test('an id with @ is encoded in the path', async () => {
    server.put(WORK, 'abc@google.com.ics', eventIcs());
    json(await run(TOOL.getEvent, { event_id: 'abc@google.com.ics' }));
    expect(server.requests[0]!.url).toBe(`https://cal.example.com${WORK}abc%40google.com.ics`);
  });

  test('a missing event is the service 404, thrown', async () => {
    await expect(run(TOOL.getEvent, { event_id: 'none.ics' })).rejects.toThrow(/HTTP 404/);
  });

  test('a malformed id is declined, nothing sent', async () => {
    expect(await refusalText(run(TOOL.getEvent, { event_id: '..' }))).toMatch(/event_id/);
    expect(server.requests).toEqual([]);
  });
});

describe('create_event', () => {
  test('a conditional PUT of a new file, the iCalendar built by the plugin', async () => {
    const out = json(
      await run(TOOL.createEvent, {
        summary: 'Plan, review; ship',
        start: '2026-10-28T10:00:00',
        end: '2026-10-28T11:00:00',
        timezone: 'Europe/Paris',
        description: 'Agenda:\n1. a\n2. b',
        attendees: ['Bob <bob@example.com>'],
      }),
    );
    const put = server.requests[0]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`https://cal.example.com${WORK}0f8c2d1e-0000-4000-8000-00000000abcd.ics`);
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers['content-type']).toBe('text/calendar; charset=utf-8');
    const body = put.body.replace(/\r\n /g, '');
    expect(body).toContain('UID:0f8c2d1e-0000-4000-8000-00000000abcd\r\n');
    expect(body).toContain('SUMMARY:Plan\\, review\\; ship\r\n');
    expect(body).toContain('DESCRIPTION:Agenda:\\n1. a\\n2. b\r\n');
    expect(body).toContain('ORGANIZER:mailto:ada@example.com\r\n');
    expect(body).toContain('mailto:bob@example.com');
    expect(out).toEqual({
      calendar: 'work',
      event_id: '0f8c2d1e-0000-4000-8000-00000000abcd.ics',
      uid: '0f8c2d1e-0000-4000-8000-00000000abcd',
      etag: '"e1"',
      created: true,
      invited: ['bob@example.com'],
    });
  });

  test('the server refuses to overwrite : 412, thrown', async () => {
    server.put(WORK, '0f8c2d1e-0000-4000-8000-00000000abcd.ics', eventIcs());
    await expect(
      run(TOOL.createEvent, {
        summary: 's',
        start: '2026-10-28T10:00:00Z',
        end: '2026-10-28T11:00:00Z',
      }),
    ).rejects.toThrow(/HTTP 412/);
  });

  test('a calendar that refuses writes : 403 is an UpstreamAuthError', async () => {
    const ctx = {
      ...execCtx(server),
      fetch: (async () => new Response(null, { status: 403 })) as typeof fetch,
    };
    await expect(
      plugin.execute(ctx, TOOL.createEvent, {
        summary: 's',
        start: '2026-10-28T10:00:00Z',
        end: '2026-10-28T11:00:00Z',
      }),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('attendees without a known account address are declined', async () => {
    const anonymous = { ...work, metadata: { ...work.metadata, account_addresses: '' } };
    expect(
      await refusalText(
        run(
          TOOL.createEvent,
          {
            summary: 's',
            start: '2026-10-28T10:00:00Z',
            end: '2026-10-28T11:00:00Z',
            attendees: ['bob@example.com'],
          },
          [anonymous],
        ),
      ),
    ).toMatch(/cannot organize a meeting/);
    expect(server.requests).toEqual([]);
  });

  test('a field the classifier refuses is declined here too', async () => {
    expect(
      await refusalText(run(TOOL.createEvent, { summary: 's', start: 'soon', end: 'later' })),
    ).toMatch(/start/);
    expect(
      await refusalText(
        run(TOOL.createEvent, {
          summary: 's',
          start: '2026-10-28T10:00:00Z',
          end: '2026-10-28T11:00:00Z',
          ics: 'BEGIN:VCALENDAR',
        }),
      ),
    ).toMatch(/not an argument/);
    expect(server.requests).toEqual([]);
  });
});

describe('update_event', () => {
  test('read, check, rewrite in place, conditional PUT', async () => {
    const etag = server.put(
      WORK,
      'evt-1.ics',
      eventIcs({ organizer: 'ada@example.com', attendees: ['bob@example.com'] }),
    );
    const out = json(
      await run(TOOL.updateEvent, {
        event_id: 'evt-1.ics',
        etag,
        summary: 'Renamed',
        attendees: ['bob@example.com', 'carol@example.com'],
      }),
    );
    expect(server.requests.map((r) => r.method)).toEqual(['GET', 'PUT']);
    const put = server.requests[1]!;
    expect(put.headers['if-match']).toBe(etag);
    const body = put.body.replace(/\r\n /g, '');
    expect(body).toContain('SUMMARY:Renamed');
    expect(body).toContain('ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com');
    expect(body).toContain('mailto:carol@example.com');
    expect(body).toContain('SEQUENCE:1');
    expect(out).toMatchObject({ event_id: 'evt-1.ics', updated: true, etag: '"e2"' });
  });

  test('an etag that moved is declined before any write', async () => {
    server.put(WORK, 'evt-1.ics', eventIcs());
    expect(
      await refusalText(
        run(TOOL.updateEvent, { event_id: 'evt-1.ics', etag: '"old"', summary: 'x' }),
      ),
    ).toMatch(/changed since it was read/);
    expect(writes()).toEqual([]);
  });

  test('attendees the call does not name are declined : who is notified is what was priced', async () => {
    const etag = server.put(
      WORK,
      'evt-1.ics',
      eventIcs({ organizer: 'ada@example.com', attendees: ['mallory@evil.example'] }),
    );
    expect(
      await refusalText(run(TOOL.updateEvent, { event_id: 'evt-1.ics', etag, summary: 'x' })),
    ).toMatch(/zone 'external', the call states 'none'/);
    expect(
      await refusalText(
        run(TOOL.updateEvent, { event_id: 'evt-1.ics', etag, attendees: ['bob@example.com'] }),
      ),
    ).toMatch(/zone 'external', the call states 'internal'/);
    expect(writes()).toEqual([]);
    json(
      await run(TOOL.updateEvent, {
        event_id: 'evt-1.ics',
        etag,
        attendees: ['bob@example.com'],
        removed_attendees: ['mallory@evil.example'],
      }),
    );
    expect(writes()).toHaveLength(1);
  });

  test('an invitation organized by somebody else is not changed', async () => {
    const etag = server.put(
      WORK,
      'evt-1.ics',
      eventIcs({ organizer: 'boss@example.com', attendees: ['ada@example.com'] }),
    );
    expect(
      await refusalText(
        run(TOOL.updateEvent, {
          event_id: 'evt-1.ics',
          etag,
          summary: 'x',
          attendees: ['boss@example.com'],
        }),
      ),
    ).toMatch(/organized by boss@example\.com/);
    expect(writes()).toEqual([]);
  });

  test('a concurrent write between the read and the PUT : 412, thrown', async () => {
    const etag = server.put(WORK, 'evt-1.ics', eventIcs());
    const ctx = execCtx(server);
    const racing = {
      ...ctx,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === 'PUT') server.put(WORK, 'evt-1.ics', eventIcs({ summary: 'theirs' }));
        return ctx.fetch(input, init);
      }) as typeof fetch,
    };
    await expect(
      plugin.execute(racing, TOOL.updateEvent, { event_id: 'evt-1.ics', etag, summary: 'mine' }),
    ).rejects.toThrow(/HTTP 412/);
  });
});

describe('delete_event', () => {
  test('read, check, conditional DELETE', async () => {
    const etag = server.put(WORK, 'evt-1.ics', eventIcs());
    expect(json(await run(TOOL.deleteEvent, { event_id: 'evt-1.ics', etag }))).toEqual({
      calendar: 'work',
      event_id: 'evt-1.ics',
      deleted: true,
    });
    const del = server.requests[1]!;
    expect(del).toMatchObject({ method: 'DELETE', url: `https://cal.example.com${WORK}evt-1.ics` });
    expect(del.headers['if-match']).toBe(etag);
    expect(server.calendar(WORK)!.objects.size).toBe(0);
  });

  test('deleting an invitation notifies its organizer : the organizer must be stated', async () => {
    const etag = server.put(
      WORK,
      'evt-1.ics',
      eventIcs({ organizer: 'boss@partner.org', attendees: ['ada@example.com'] }),
    );
    expect(await refusalText(run(TOOL.deleteEvent, { event_id: 'evt-1.ics', etag }))).toMatch(
      /zone 'allowlist'/,
    );
    expect(writes()).toEqual([]);
    json(
      await run(TOOL.deleteEvent, { event_id: 'evt-1.ics', etag, attendees: ['boss@partner.org'] }),
    );
    expect(writes()).toHaveLength(1);
  });

  test('a non-mailto attendee counts as external', async () => {
    const ics = eventIcs({ organizer: 'ada@example.com' }).replace(
      'END:VEVENT',
      'ATTENDEE:urn:uuid:room-12\r\nEND:VEVENT',
    );
    const etag = server.put(WORK, 'evt-1.ics', ics);
    expect(
      await refusalText(
        run(TOOL.deleteEvent, { event_id: 'evt-1.ics', etag, attendees: ['bob@example.com'] }),
      ),
    ).toMatch(/zone 'external'/);
  });
});

describe('unknown tool and calendar selection', () => {
  test('declined, nothing sent', async () => {
    expect(await refusalText(run('caldav__nope', {}))).toMatch(/unknown tool/);
    expect(await refusalText(run(TOOL.getEvent, { event_id: 'a.ics' }, [work, home]))).toMatch(
      /name one/,
    );
    expect(await refusalText(run(TOOL.getEvent, { event_id: 'a.ics', calendar: 'other' }))).toMatch(
      /not a calendar of this mission/,
    );
    expect(server.requests).toEqual([]);
  });
});
