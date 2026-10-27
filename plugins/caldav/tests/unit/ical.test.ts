/**
 * The iCalendar codec of the `caldav` plugin (RFC 5545 §3.1, §3.3.11) :
 * unfolding, content lines, components, escaping, folding — and the event
 * views and writes built on it.
 */
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { propertyRuns } from '@vaubaan/plugin-sdk/testing';

import { readEventInput } from '../../src/classify.ts';
import {
  applyChange,
  buildEvent,
  concernedPeople,
  eventView,
  organizerOf,
} from '../../src/event.ts';
import {
  IcsError,
  escapeText,
  foldLine,
  parseContentLine,
  parseIcs,
  serializeIcs,
  unescapeText,
} from '../../src/ical.ts';

const CRLF = '\r\n';
const ics = (...lines: string[]): string => lines.join(CRLF) + CRLF;

export const MEETING = ics(
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//Server//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Paris',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:meeting-1@example.com',
  'DTSTAMP:20261020T080000Z',
  'DTSTART;TZID=Europe/Paris:20261027T100000',
  'DTEND;TZID=Europe/Paris:20261027T110000',
  'SUMMARY:Budget\\, Q4 review',
  'LOCATION:Room 4\\; floor 2',
  'DESCRIPTION:Line one\\nLine two with a long text that goes past the seventy-five oc',
  ' tets of a line and is folded by the server',
  'ORGANIZER;CN=Ada:mailto:ada@example.com',
  'ATTENDEE;CN="Lovelace, Bob";PARTSTAT=ACCEPTED:mailto:bob@example.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:carol@partner.org',
  'RRULE:FREQ=WEEKLY;BYDAY=TU',
  'SEQUENCE:3',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:meeting-1@example.com',
  'RECURRENCE-ID;TZID=Europe/Paris:20261103T100000',
  'DTSTART;TZID=Europe/Paris:20261103T140000',
  'DTEND;TZID=Europe/Paris:20261103T150000',
  'SUMMARY:Budget\\, Q4 review (moved)',
  'ATTENDEE:mailto:dan@elsewhere.net',
  'END:VEVENT',
  'END:VCALENDAR',
);

describe('content lines', () => {
  test('name, parameters (quoted, several values) and value', () => {
    const p = parseContentLine(
      'ATTENDEE;CN="Doe, Jane";MEMBER="mailto:a@x.com","mailto:b@x.com";ROLE=CHAIR:mailto:jane@x.com',
    );
    expect(p.name).toBe('ATTENDEE');
    expect(p.params).toEqual([
      { name: 'CN', values: ['Doe, Jane'] },
      { name: 'MEMBER', values: ['mailto:a@x.com', 'mailto:b@x.com'] },
      { name: 'ROLE', values: ['CHAIR'] },
    ]);
    expect(p.value).toBe('mailto:jane@x.com');
  });

  test('a value keeps its colons', () => {
    expect(parseContentLine('URL:https://example.com:8443/x').value).toBe(
      'https://example.com:8443/x',
    );
  });

  test.each([
    ['no name', ':value'],
    ['no value', 'SUMMARY'],
    ['a parameter without =', 'DTSTART;TZID:2026'],
    ['an unclosed quote', 'ATTENDEE;CN="Jane:mailto:j@x.com'],
  ])('refuses %s', (_why, line) => {
    expect(() => parseContentLine(line)).toThrow(IcsError);
  });
});

describe('parseIcs', () => {
  test('reads components in order, unfolding continuation lines', () => {
    const cal = parseIcs(MEETING);
    expect(cal.name).toBe('VCALENDAR');
    expect(cal.components.map((c) => c.name)).toEqual(['VTIMEZONE', 'VEVENT', 'VEVENT']);
    const description = cal.components[1]!.properties.find((p) => p.name === 'DESCRIPTION')!;
    expect(description.value).toContain('seventy-five octets of a line');
  });

  test('accepts LF-only line ends', () => {
    expect(parseIcs(MEETING.replace(/\r\n/g, '\n')).components).toHaveLength(3);
  });

  test.each([
    ['not a calendar', ics('BEGIN:VEVENT', 'END:VEVENT')],
    ['an unclosed component', ics('BEGIN:VCALENDAR', 'BEGIN:VEVENT')],
    ['a mismatched END', ics('BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'END:VCALENDAR', 'END:VEVENT')],
    ['a property outside any component', ics('SUMMARY:x', 'BEGIN:VCALENDAR', 'END:VCALENDAR')],
    [
      'content after the end',
      ics('BEGIN:VCALENDAR', 'END:VCALENDAR', 'BEGIN:VCALENDAR', 'END:VCALENDAR'),
    ],
    ['an HTML page', '<html><body>Login</body></html>'],
  ])('refuses %s', (_why, text) => {
    expect(() => parseIcs(text)).toThrow(IcsError);
  });

  test('refuses an object too large or too deep', () => {
    expect(() => parseIcs('X'.repeat(1_000_001))).toThrow(/too large/);
    const deep = ics('BEGIN:VCALENDAR', ...Array.from({ length: 9 }, (_, i) => `BEGIN:X${i}`));
    expect(() => parseIcs(deep)).toThrow(/too deep/);
  });

  test('round-trips through serializeIcs, every property kept', () => {
    const once = serializeIcs(parseIcs(MEETING));
    expect(serializeIcs(parseIcs(once))).toBe(once);
    expect(once).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    expect(once).toContain('BEGIN:VALARM');
    expect(once).toContain('ATTENDEE;CN="Lovelace, Bob";PARTSTAT=ACCEPTED:mailto:bob@example.com');
  });
});

describe('text values and folding', () => {
  test('escapes and unescapes backslash, semicolon, comma and line breaks', () => {
    const text = 'a\\b; c, d\r\ne\nf';
    expect(escapeText(text)).toBe('a\\\\b\\; c\\, d\\ne\\nf');
    expect(unescapeText(escapeText(text))).toBe('a\\b; c, d\ne\nf');
    expect(unescapeText('x\\Ny\\:z\\')).toBe('x\ny:z\\');
  });

  test('folds at 75 octets without splitting a UTF-8 character', () => {
    const line = `SUMMARY:${'é'.repeat(100)}`;
    const folded = foldLine(line);
    for (const part of folded.split(CRLF))
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(
      folded
        .split(CRLF)
        .slice(1)
        .every((p) => p.startsWith(' ')),
    ).toBe(true);
    expect(parseContentLine(folded.replace(/\r\n /g, '')).value).toBe('é'.repeat(100));
  });

  test('a written value or parameter with a control character is refused', () => {
    const cal = parseIcs(ics('BEGIN:VCALENDAR', 'END:VCALENDAR'));
    cal.properties.push({
      name: 'SUMMARY',
      params: [],
      value: 'a\r\nATTENDEE:mailto:x@evil.example',
    });
    expect(() => serializeIcs(cal)).toThrow(IcsError);
    cal.properties.pop();
    cal.properties.push({ name: 'SUMMARY', params: [{ name: 'CN', values: ['a"b'] }], value: 'x' });
    expect(() => serializeIcs(cal)).toThrow(IcsError);
  });

  test('property : any text survives escape, write, read and unescape', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        // eslint-disable-next-line no-control-regex
        const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
        const cal = parseIcs(ics('BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'END:VEVENT', 'END:VCALENDAR'));
        cal.components[0]!.properties.push({
          name: 'DESCRIPTION',
          params: [],
          value: escapeText(clean),
        });
        const back = parseIcs(serializeIcs(cal)).components[0]!.properties[0]!;
        expect(unescapeText(back.value)).toBe(clean.replace(/\r\n|\r/g, '\n'));
      }),
      propertyRuns(),
    );
  });
});

describe('event views', () => {
  test('the master of a series, its fields unescaped, its changed occurrences counted', () => {
    const view = eventView(parseIcs(MEETING), 2000)!;
    expect(view).toMatchObject({
      uid: 'meeting-1@example.com',
      summary: 'Budget, Q4 review',
      start: '2026-10-27T10:00:00',
      end: '2026-10-27T11:00:00',
      timezone: 'Europe/Paris',
      all_day: false,
      location: 'Room 4; floor 2',
      recurrence: 'FREQ=WEEKLY;BYDAY=TU',
      changed_occurrences: 1,
      organizer: { address: 'ada@example.com', name: 'Ada', status: null },
    });
    expect(view.description!.startsWith('Line one\nLine two')).toBe(true);
    expect(view.attendees).toEqual([
      { address: 'bob@example.com', name: 'Lovelace, Bob', status: 'ACCEPTED' },
      { address: 'carol@partner.org', name: null, status: 'NEEDS-ACTION' },
    ]);
  });

  test('caps the description and says so', () => {
    const view = eventView(parseIcs(MEETING), 10)!;
    expect(view.description).toHaveLength(10);
    expect(view.description_truncated).toBe(true);
  });

  test('an all-day event, a UTC one, a DURATION and a non-mailto attendee', () => {
    const cal = parseIcs(
      ics(
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:x',
        'DTSTART;VALUE=DATE:20261224',
        'DTEND;VALUE=DATE:20261226',
        'ATTENDEE:urn:uuid:room-12',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
    );
    expect(eventView(cal, 100)).toMatchObject({
      start: '2026-12-24',
      end: '2026-12-26',
      all_day: true,
      timezone: null,
    });
    expect(eventView(cal, 100)!.attendees).toEqual([
      { address: null, name: null, status: null, uri: 'urn:uuid:room-12' },
    ]);
    const utc = parseIcs(
      ics(
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTART:20261027T090000Z',
        'DURATION:PT45M',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
    );
    expect(eventView(utc, 100)).toMatchObject({
      start: '2026-10-27T09:00:00Z',
      timezone: 'UTC',
      end: null,
      duration: 'PT45M',
    });
  });

  test('concerned people : organizer and attendees of every event, a non-mailto one unreadable', () => {
    const people = concernedPeople(parseIcs(MEETING)).map((p) => p?.address ?? null);
    expect(people).toEqual([
      'ada@example.com',
      'bob@example.com',
      'carol@partner.org',
      'dan@elsewhere.net',
    ]);
    expect(organizerOf(parseIcs(MEETING))?.address).toBe('ada@example.com');
  });
});

describe('writing events', () => {
  const now = new Date('2026-10-27T08:00:00Z');

  test('buildEvent escapes, organizes a meeting and invites', () => {
    const input = readEventInput(
      {
        summary: 'Lunch; with, friends\nand more',
        start: '2026-10-28T12:00:00',
        end: '2026-10-28T13:30:00',
        timezone: 'Europe/Paris',
        location: 'Café',
        attendees: ['Bob <bob@example.com>', 'carol@partner.org', 'ada@example.com'],
      },
      'create',
    );
    if ('denied' in input) throw new Error(input.denied);
    const text = serializeIcs(
      buildEvent(input, { uid: 'u-1', now, organizer: 'ada@example.com' }),
    ).replace(/\r\n /g, '');
    expect(text).toContain('SUMMARY:Lunch\\; with\\, friends\\nand more\r\n');
    expect(text).toContain('DTSTART;TZID=Europe/Paris:20261028T120000\r\n');
    expect(text).toContain('DTEND;TZID=Europe/Paris:20261028T133000\r\n');
    expect(text).toContain('ORGANIZER:mailto:ada@example.com\r\n');
    expect(text).toContain(
      'ATTENDEE;CN=Bob;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com',
    );
    expect(text).not.toMatch(/^ATTENDEE.*ada@example\.com/m);
    expect(text.match(/^ATTENDEE/gm)).toHaveLength(2);
    expect(text).toContain('UID:u-1\r\nDTSTAMP:20261027T080000Z');
    expect(parseIcs(text).components).toHaveLength(1);
  });

  test('an instant is written in UTC, a date as VALUE=DATE', () => {
    const instant = readEventInput(
      { summary: 's', start: '2026-10-28T12:00:00+02:00', end: '2026-10-28T13:00:00+02:00' },
      'create',
    );
    if ('denied' in instant) throw new Error(instant.denied);
    expect(serializeIcs(buildEvent(instant, { uid: 'u', now, organizer: null }))).toContain(
      'DTSTART:20261028T100000Z',
    );
    const day = readEventInput(
      { summary: 's', start: '2026-12-24', end: '2026-12-25', all_day: true },
      'create',
    );
    if ('denied' in day) throw new Error(day.denied);
    expect(serializeIcs(buildEvent(day, { uid: 'u', now, organizer: null }))).toContain(
      'DTSTART;VALUE=DATE:20261224',
    );
  });

  test('applyChange rewrites the named fields only and keeps the rest', () => {
    const cal = parseIcs(
      MEETING.replace(
        /BEGIN:VEVENT\r\nUID:meeting-1@example.com\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/,
        '',
      ),
    );
    const input = readEventInput(
      { summary: 'New title', location: '', attendees: ['bob@example.com', 'eve@example.com'] },
      'update',
    );
    if ('denied' in input) throw new Error(input.denied);
    expect(applyChange(cal, input, { now, organizer: 'ada@example.com' })).toBeNull();
    const text = serializeIcs(cal).replace(/\r\n /g, '');
    expect(text).toContain('SUMMARY:New title');
    expect(text).not.toContain('LOCATION');
    expect(text).toContain('ATTENDEE;CN="Lovelace, Bob";PARTSTAT=ACCEPTED:mailto:bob@example.com');
    expect(text).toContain('mailto:eve@example.com');
    expect(text).not.toContain('carol@partner.org');
    expect(text).toContain('SEQUENCE:4');
    expect(text).toContain('BEGIN:VALARM');
    expect(text).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    expect(text).toContain('DTSTART;TZID=Europe/Paris:20261027T100000');
  });

  test('applyChange declines a new time or new attendees on a series with changed occurrences', () => {
    const input = readEventInput(
      { start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' },
      'update',
    );
    if ('denied' in input) throw new Error(input.denied);
    expect(applyChange(parseIcs(MEETING), input, { now, organizer: null })).toMatch(
      /changed one by one/,
    );
    const title = readEventInput({ summary: 'x' }, 'update');
    if ('denied' in title) throw new Error(title.denied);
    expect(applyChange(parseIcs(MEETING), title, { now, organizer: null })).toBeNull();
  });
});
