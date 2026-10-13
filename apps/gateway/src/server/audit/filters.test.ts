import { describe, expect, it } from 'vitest';

import {
  auditQueryString,
  decodeCursor,
  encodeCursor,
  parseAuditQuery,
  parseInstant,
} from './filters';
import { scopeOf, withoutArguments } from './query-service';

const EMPTY = {
  missionId: null,
  user: null,
  connectionId: null,
  tool: null,
  decision: null,
  agentLabel: null,
  kind: null,
  since: null,
  until: null,
};

describe('parseAuditQuery', () => {
  it('an empty query is no filter, no cursor, no problem', () => {
    expect(parseAuditQuery({})).toEqual({ filters: EMPTY, cursor: null, raw: {}, problems: [] });
    expect(parseAuditQuery(new URLSearchParams()).filters).toEqual(EMPTY);
  });

  it('reads every filter, trimmed', () => {
    const parsed = parseAuditQuery(
      new URLSearchParams({
        mission: ' m-1 ',
        user: 'ada@example.com',
        connection: 'c-1',
        tool: 'github__get_file',
        decision: 'refused',
        agent: ' planner ',
        kind: 'call',
        from: '2026-10-01',
        to: '2026-10-13',
      }),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.filters).toEqual({
      missionId: 'm-1',
      user: 'ada@example.com',
      connectionId: 'c-1',
      tool: 'github__get_file',
      decision: 'refused',
      agentLabel: 'planner',
      kind: 'call',
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-14T00:00:00.000Z',
    });
    expect(parsed.raw.mission).toBe('m-1');
  });

  it('takes the first value of a repeated parameter and ignores blanks', () => {
    const parsed = parseAuditQuery({ tool: ['a', 'b'], mission: '   ', user: undefined });
    expect(parsed.filters).toEqual({ ...EMPTY, tool: 'a' });
    expect(parsed.raw).toEqual({ tool: 'a' });
  });

  it('drops a decision or a kind outside the closed sets, and says so', () => {
    const parsed = parseAuditQuery({ decision: 'denied', kind: 'everything', tool: 't' });
    expect(parsed.filters).toEqual({ ...EMPTY, tool: 't' });
    expect(parsed.raw).toEqual({ tool: 't' });
    expect(parsed.problems).toEqual([
      'decision: expected allowed or refused',
      'kind: expected call or admin',
    ]);
  });

  it('drops an unreadable date instead of guessing', () => {
    for (const bad of [
      'yesterday',
      '2026-13-01',
      '2026-02-31',
      '13/10/2026',
      '2026-10-13T25:00Z',
    ]) {
      const parsed = parseAuditQuery({ from: bad });
      expect(parsed.filters.since, bad).toBeNull();
      expect(parsed.problems, bad).toEqual(['from: expected a date (YYYY-MM-DD)']);
      expect(parsed.raw, bad).toEqual({});
    }
    expect(parseAuditQuery({ to: 'nope' }).problems).toEqual(['to: expected a date (YYYY-MM-DD)']);
  });

  it('ignores a period whose start is after its end', () => {
    const parsed = parseAuditQuery({ from: '2026-10-13', to: '2026-10-01', tool: 't' });
    expect(parsed.filters).toEqual({ ...EMPTY, tool: 't' });
    expect(parsed.raw).toEqual({ tool: 't' });
    expect(parsed.problems).toHaveLength(1);
  });

  it('a single day is a period: from 00:00 to the next 00:00, UTC', () => {
    const { filters } = parseAuditQuery({ from: '2026-10-13', to: '2026-10-13' });
    expect([filters.since, filters.until]).toEqual([
      '2026-10-13T00:00:00.000Z',
      '2026-10-14T00:00:00.000Z',
    ]);
  });

  it('refuses an oversized value', () => {
    const parsed = parseAuditQuery({ tool: 'x'.repeat(201) });
    expect(parsed.filters.tool).toBeNull();
    expect(parsed.problems).toEqual(['tool: value too long, ignored']);
  });

  it('reads the cursor, and falls back to the first page on an unreadable one', () => {
    const cursor = { ts: '2026-10-13T09:00:00.000Z', id: '0199-abc' };
    expect(parseAuditQuery({ cursor: encodeCursor(cursor) }).cursor).toEqual(cursor);
    const bad = parseAuditQuery({ cursor: 'not a cursor!' });
    expect(bad.cursor).toBeNull();
    expect(bad.raw).toEqual({});
    expect(bad.problems).toEqual(['cursor: unreadable, showing the first page']);
  });
});

describe('parseInstant', () => {
  it('accepts a day or a full instant, normalized to UTC', () => {
    expect(parseInstant('2026-10-13', false)).toBe('2026-10-13T00:00:00.000Z');
    expect(parseInstant('2026-10-13', true)).toBe('2026-10-14T00:00:00.000Z');
    expect(parseInstant('2026-10-13T10:30:00+02:00', false)).toBe('2026-10-13T08:30:00.000Z');
    expect(parseInstant('2026-10-13T10:30:00Z', true)).toBe('2026-10-13T10:30:00.000Z');
    expect(parseInstant('2026-12-31', true)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('refuses anything else', () => {
    for (const bad of ['', '2026', '2026-10-13 10:30', '2026-10-13T10:30', 'now']) {
      expect(parseInstant(bad, false), bad).toBeNull();
    }
  });
});

describe('cursor', () => {
  it('round-trips, url-safe', () => {
    const cursor = { ts: '2026-10-13T09:00:00.123Z', id: '01999999-aaaa-7bbb-8ccc-dddddddddddd' };
    const text = encodeCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(text)).toEqual(cursor);
  });

  it('refuses what it did not produce', () => {
    const encode = (raw: string) => Buffer.from(raw, 'utf8').toString('base64url');
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('a b')).toBeNull();
    expect(decodeCursor(encode('no-separator'))).toBeNull();
    expect(decodeCursor(encode('2026-10-13T09:00:00.000Z|'))).toBeNull();
    expect(decodeCursor(encode('yesterday|id'))).toBeNull();
    // Not the canonical form the store writes: it would compare wrongly as text.
    expect(decodeCursor(encode('2026-10-13T09:00:00Z|id'))).toBeNull();
    expect(decodeCursor('x'.repeat(201))).toBeNull();
  });
});

describe('auditQueryString', () => {
  it('keeps the filters and replaces the position', () => {
    const { raw } = parseAuditQuery({
      mission: 'm-1',
      decision: 'refused',
      cursor: encodeCursor({ ts: '2026-10-13T09:00:00.000Z', id: 'a' }),
    });
    expect(auditQueryString(raw, null)).toBe('mission=m-1&decision=refused');
    const next = { ts: '2026-10-12T09:00:00.000Z', id: 'b' };
    const params = new URLSearchParams(auditQueryString(raw, next));
    expect(params.get('mission')).toBe('m-1');
    expect(decodeCursor(params.get('cursor') ?? '')).toEqual(next);
  });
});

describe('scopeOf — the visibility rule', () => {
  const user = { id: 'u-1' };

  it('a user: the missions they created, the connections they and their groups own', () => {
    expect(
      scopeOf({ kind: 'user', user, groups: [{ id: 'g-1' }, { id: 'g-2' }], isOperator: false }),
    ).toEqual({
      missionCreatorUserId: 'u-1',
      connectionOwners: [
        { kind: 'user', id: 'u-1' },
        { kind: 'group', id: 'g-1' },
        { kind: 'group', id: 'g-2' },
      ],
      allAdmin: false,
    });
  });

  it('an operator: the same, and every administrative entry', () => {
    expect(scopeOf({ kind: 'user', user, groups: [], isOperator: true })).toEqual({
      missionCreatorUserId: 'u-1',
      connectionOwners: [{ kind: 'user', id: 'u-1' }],
      allAdmin: true,
    });
  });

  it('the bootstrap operator: administrative entries only', () => {
    expect(scopeOf({ kind: 'bootstrap' })).toEqual({
      missionCreatorUserId: null,
      connectionOwners: [],
      allAdmin: true,
    });
  });
});

describe('withoutArguments', () => {
  it('hides argument-named keys at any depth and keeps the rest', () => {
    expect(
      withoutArguments({
        tool: 't',
        Arguments: { a: 1 },
        list: [{ args: [1, 2], kept: true }],
        nothing: null,
      }),
    ).toEqual({
      tool: 't',
      Arguments: '[not shown]',
      list: [{ args: '[not shown]', kept: true }],
      nothing: null,
    });
    expect(withoutArguments(null)).toBeNull();
    expect(withoutArguments('text')).toBe('text');
  });
});
