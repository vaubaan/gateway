/**
 * The `caldav` classifier, branch by branch : calendar selection, time
 * ranges, identifiers, event fields, and the attendee zone of every write.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ClassifyOutcome } from '@vaubaan/plugin-sdk';

import { classifyCaldav, readZoning, zoneOf } from '../../src/classify.ts';
import { parseAttendee } from '../../src/address.ts';
import { TOOL } from '../../src/identity.ts';
import { githubRepo, home, work } from './fixtures.ts';

const slices = (outcome: ClassifyOutcome): string[] => {
  if ('denied' in outcome) throw new Error(`denied: ${outcome.denied}`);
  return outcome.slices.map(serializeSlice);
};
const denied = (outcome: ClassifyOutcome): string => {
  if (!('denied' in outcome)) throw new Error(`not denied: ${slices(outcome).join(' ')}`);
  return outcome.denied;
};

const RANGE = { start: '2026-10-26', end: '2026-11-02' };
const EVENT = { summary: 'Sync', start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' };
const ETAG = '"e12"';

describe('tools and arguments', () => {
  test('an unknown tool is denied', () => {
    expect(denied(classifyCaldav('caldav__free_busy', {}, [work]))).toMatch(/unknown caldav tool/);
  });

  test('an argument the tool does not declare is denied', () => {
    expect(
      denied(
        classifyCaldav(TOOL.getEvent, { event_id: 'a.ics', raw_ics: 'BEGIN:VCALENDAR' }, [work]),
      ),
    ).toMatch(/raw_ics: not an argument/);
  });
});

describe('calendar selection', () => {
  test('list_calendars reads every calendar of the mission', () => {
    expect(slices(classifyCaldav(TOOL.listCalendars, {}, [work, home, githubRepo]))).toEqual([
      'caldav.calendar[work].R',
      'caldav.calendar[home].R',
    ]);
    expect(denied(classifyCaldav(TOOL.listCalendars, {}, [githubRepo]))).toMatch(/no calendar/);
  });

  test('the single calendar of the mission when calendar is omitted', () => {
    expect(slices(classifyCaldav(TOOL.listEvents, RANGE, [work]))).toEqual([
      'caldav.calendar[work].event[*].R',
    ]);
  });

  test('several calendars and none named : denied, never one picked', () => {
    expect(denied(classifyCaldav(TOOL.listEvents, RANGE, [work, home]))).toMatch(/2 calendars/);
  });

  test('a named calendar must be one of the mission', () => {
    expect(
      slices(classifyCaldav(TOOL.listEvents, { ...RANGE, calendar: 'home' }, [work, home])),
    ).toEqual(['caldav.calendar[home].event[*].R']);
    expect(
      denied(classifyCaldav(TOOL.listEvents, { ...RANGE, calendar: 'secret' }, [work])),
    ).toMatch(/not a calendar of this mission/);
  });

  test.each(['..', '.', 'a/b', '%2e%2e', 'work\n', '', 42])(
    'a malformed calendar %j is denied',
    (calendar) => {
      expect('denied' in classifyCaldav(TOOL.listEvents, { ...RANGE, calendar }, [work])).toBe(
        true,
      );
    },
  );

  test('no calendar resource : denied', () => {
    expect(denied(classifyCaldav(TOOL.getEvent, { event_id: 'a.ics' }, [githubRepo]))).toMatch(
      /no calendar/,
    );
  });
});

describe('list_events — time ranges', () => {
  test('up to 31 days is a plain read', () => {
    expect(
      slices(classifyCaldav(TOOL.listEvents, { start: '2026-10-01', end: '2026-11-01' }, [work])),
    ).toEqual(['caldav.calendar[work].event[*].R']);
  });

  test('beyond 31 days adds the wide-range marker', () => {
    expect(
      slices(
        classifyCaldav(
          TOOL.listEvents,
          { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:01Z' },
          [work],
        ),
      ),
    ).toEqual(['caldav.calendar[work].event[*].R', 'caldav.calendar[work].wide-range.R']);
  });

  test('offsets are honoured : the same instant written two ways', () => {
    expect(
      slices(
        classifyCaldav(
          TOOL.listEvents,
          { start: '2026-10-01T02:00:00+02:00', end: '2026-11-01T00:00:00Z' },
          [work],
        ),
      ),
    ).toHaveLength(1);
  });

  test.each([
    [{ start: '2026-10-01', end: '2027-10-03' }, /longer than 366 days/],
    [{ start: '2026-10-02', end: '2026-10-01' }, /after start/],
    [{ start: '2026-10-01', end: '2026-10-01' }, /after start/],
    [{ start: 'tomorrow', end: '2026-10-01' }, /start: missing or malformed/],
    [{ start: '2026-10-01' }, /end: missing or malformed/],
    [{ start: '2026-02-30', end: '2026-03-02' }, /start/],
    [{ start: '2026-10-01T10:00:00', end: '2026-10-02' }, /start/],
    [{ ...RANGE, max_results: 0 }, /max_results/],
    [{ ...RANGE, max_results: 201 }, /max_results/],
    [{ ...RANGE, max_results: 2.5 }, /max_results/],
  ])('denies %j', (args, reason) => {
    expect(denied(classifyCaldav(TOOL.listEvents, args, [work]))).toMatch(reason);
  });
});

describe('get_event — identifiers', () => {
  test('the event id is the identifier of the slice', () => {
    expect(slices(classifyCaldav(TOOL.getEvent, { event_id: '3f2a-9c.ics' }, [work]))).toEqual([
      'caldav.calendar[work].event[3f2a-9c.ics].R',
    ]);
  });

  test('an id the slice grammar cannot carry is written as any identifier', () => {
    expect(
      slices(classifyCaldav(TOOL.getEvent, { event_id: 'abc@google.com.ics' }, [work])),
    ).toEqual(['caldav.calendar[work].event[*].R']);
  });

  test.each([
    '..',
    '.',
    '.hidden',
    'a/../b',
    '%2e%2e',
    '..%2f',
    'a b',
    'r1?x=1#y',
    'x\ny',
    '',
    'a'.repeat(256),
  ])('a malformed event id %j is denied', (event_id) => {
    expect('denied' in classifyCaldav(TOOL.getEvent, { event_id }, [work])).toBe(true);
  });
});

describe('create_event — fields and attendee zones', () => {
  test('without attendees : the event write alone', () => {
    expect(slices(classifyCaldav(TOOL.createEvent, EVENT, [work]))).toEqual([
      'caldav.calendar[work].event.W',
    ]);
  });

  test('inviting the account itself notifies nobody', () => {
    expect(
      slices(
        classifyCaldav(TOOL.createEvent, { ...EVENT, attendees: ['Ada <ada@example.com>'] }, [
          work,
        ]),
      ),
    ).toEqual(['caldav.calendar[work].event.W']);
  });

  test.each([
    [['bob@example.com'], 'internal'],
    [['bob@example.com', 'carol@partner.org'], 'allowlist'],
    [['bob@vendor.io'], 'allowlist'],
    [['bob@example.com', 'mallory@evil.example'], 'external'],
    [['ADA@EXAMPLE.COM', 'eve@sub.example.com'], 'external'],
  ])('attendees %j are zone %s, the worst of them', (attendees, zone) => {
    expect(slices(classifyCaldav(TOOL.createEvent, { ...EVENT, attendees }, [work]))).toEqual([
      'caldav.calendar[work].event.W',
      `caldav.calendar[work].attendee-zone[${zone}].W`,
    ]);
  });

  test('a calendar without zoning lists makes every other person external', () => {
    const bare = {
      ...work,
      metadata: { href: work.metadata!.href, account_addresses: 'ada@example.com' },
    };
    expect(
      slices(
        classifyCaldav(TOOL.createEvent, { ...EVENT, attendees: ['bob@example.com'] }, [bare]),
      ),
    ).toContain('caldav.calendar[work].attendee-zone[external].W');
  });

  test.each([
    [{ ...EVENT, attendees: ['a@example.com, b@evil.example'] }, /not exactly one e-mail address/],
    [{ ...EVENT, attendees: 'bob@example.com' }, /list of addresses/],
    [
      { ...EVENT, attendees: Array.from({ length: 101 }, (_, i) => `p${i}@example.com`) },
      /at most 100/,
    ],
    [{ ...EVENT, summary: undefined }, /summary: missing/],
    [{ ...EVENT, summary: '   ' }, /summary: must not be empty/],
    [{ ...EVENT, summary: 'a\u0007b' }, /control character/],
    [{ ...EVENT, summary: 'x'.repeat(501) }, /at most 500/],
    [{ ...EVENT, description: 'x'.repeat(8001) }, /at most 8000/],
    [{ ...EVENT, end: undefined }, /give both/],
    [{ ...EVENT, end: '2026-10-27T08:00:00Z' }, /after start/],
    [{ ...EVENT, start: '2026-10-27T09:00:00' }, /instant with its offset/],
    [{ ...EVENT, timezone: 'Mars/Olympus' }, /IANA/],
    [{ ...EVENT, timezone: '../etc' }, /IANA/],
    [{ ...EVENT, timezone: 'Europe/Paris' }, /wall-clock/],
    [{ ...EVENT, all_day: true }, /all-day event takes a date/],
    [{ ...EVENT, all_day: 'yes' }, /all_day/],
    [
      { summary: 's', start: '2026-12-24', end: '2026-12-25', all_day: true, timezone: 'UTC' },
      /an all-day event has none/,
    ],
  ])('denies %j', (args, reason) => {
    expect(denied(classifyCaldav(TOOL.createEvent, args, [work]))).toMatch(reason);
  });

  test('a wall-clock time with a timezone, and an all-day event, are accepted', () => {
    expect(
      'slices' in
        classifyCaldav(
          TOOL.createEvent,
          {
            summary: 's',
            start: '2026-10-27T10:00',
            end: '2026-10-27T11:00',
            timezone: 'Europe/Paris',
          },
          [work],
        ),
    ).toBe(true);
    expect(
      'slices' in
        classifyCaldav(
          TOOL.createEvent,
          { summary: 's', start: '2026-12-24', end: '2026-12-25', all_day: true },
          [work],
        ),
    ).toBe(true);
  });
});

describe('update_event and delete_event — what the call states', () => {
  const target = { event_id: 'evt-1.ics', etag: ETAG };

  test('a change is the event write ; its stated attendees and removed attendees are priced together', () => {
    expect(slices(classifyCaldav(TOOL.updateEvent, { ...target, summary: 'x' }, [work]))).toEqual([
      'caldav.calendar[work].event[evt-1.ics].W',
    ]);
    expect(
      slices(
        classifyCaldav(
          TOOL.updateEvent,
          {
            ...target,
            attendees: ['bob@example.com'],
            removed_attendees: ['mallory@evil.example'],
          },
          [work],
        ),
      ),
    ).toEqual([
      'caldav.calendar[work].event[evt-1.ics].W',
      'caldav.calendar[work].attendee-zone[external].W',
    ]);
  });

  test('a deletion is the delete leaf, priced by the people it states', () => {
    expect(slices(classifyCaldav(TOOL.deleteEvent, target, [work]))).toEqual([
      'caldav.calendar[work].event[evt-1.ics].delete.W',
    ]);
    expect(
      slices(
        classifyCaldav(TOOL.deleteEvent, { ...target, attendees: ['carol@partner.org'] }, [work]),
      ),
    ).toEqual([
      'caldav.calendar[work].event[evt-1.ics].delete.W',
      'caldav.calendar[work].attendee-zone[allowlist].W',
    ]);
  });

  test.each([
    [TOOL.updateEvent, { event_id: 'evt-1.ics', summary: 'x' }, /etag: missing/],
    [TOOL.updateEvent, { ...target, etag: 'a b' }, /etag: malformed/],
    [TOOL.updateEvent, { ...target, etag: '"x"\r\nX-Evil: 1' }, /etag: malformed/],
    [TOOL.updateEvent, target, /nothing to change/],
    [TOOL.updateEvent, { ...target, start: '2026-10-27T09:00:00Z' }, /give both/],
    [TOOL.updateEvent, { ...target, timezone: 'Europe/Paris' }, /with start and end only/],
    [TOOL.updateEvent, { ...target, summary: '' }, /must not be empty/],
    [
      TOOL.updateEvent,
      { ...target, summary: 'x', removed_attendees: ['not an address'] },
      /removed_attendees/,
    ],
    [TOOL.deleteEvent, { etag: ETAG }, /event_id: missing/],
    [TOOL.deleteEvent, { ...target, attendees: [42] }, /not exactly one e-mail address/],
    [TOOL.deleteEvent, { ...target, summary: 'x' }, /summary: not an argument/],
  ])('%s denies %j', (tool, args, reason) => {
    expect(denied(classifyCaldav(tool, args, [work]))).toMatch(reason);
  });

  test('an empty location or description removes it', () => {
    expect(
      'slices' in
        classifyCaldav(TOOL.updateEvent, { ...target, location: '', description: '' }, [work]),
    ).toBe(true);
  });
});

describe('zoning', () => {
  test('lists are read case-insensitively ; the account addresses may be a list or a string', () => {
    const z = readZoning({
      ...work,
      metadata: {
        internal_domains: ['Example.COM'],
        account_addresses: ['Ada@Example.com'],
        allowlist_domains: 'x',
      },
    });
    expect(z).toEqual({
      internal_domains: ['example.com'],
      allowlist_domains: ['x'],
      allowlist_addresses: [],
      account_addresses: ['ada@example.com'],
    });
    expect(zoneOf([parseAttendee('ada@example.com'), parseAttendee('b@example.com')], z)).toBe(
      'internal',
    );
    expect(zoneOf([null], z)).toBe('external');
    expect(zoneOf([], z)).toBe('none');
  });
});
