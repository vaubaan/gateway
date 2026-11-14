import { describe, expect, it } from 'vitest';

import {
  auditQueryString,
  decodeCursor,
  encodeCursor,
  parseAuditQuery,
  parseInstant,
} from './filters';
import { holderParam, parseHolderParam } from './session-view';
import {
  ARGUMENTS_NOT_SHOWN,
  scopeOf,
  standingOn,
  withoutArguments,
  type AuditViewer,
} from './query-service';

const EMPTY = {
  missionId: null,
  user: null,
  accountId: null,
  tool: null,
  decision: null,
  agentLabel: null,
  tokenHolder: null,
  kind: null,
  since: null,
  until: null,
};

describe('parseAuditQuery', () => {
  it('an empty query is no filter, no problem', () => {
    expect(parseAuditQuery({})).toEqual({ filters: EMPTY, raw: {}, problems: [] });
    expect(parseAuditQuery(new URLSearchParams()).filters).toEqual(EMPTY);
  });

  it('reads every filter, trimmed', () => {
    const parsed = parseAuditQuery(
      new URLSearchParams({
        mission: ' m-1 ',
        user: 'ada@example.com',
        account: 'c-1',
        tool: 'github__get_file',
        decision: 'refused',
        agent: ' planner ',
        holder: ' bob@example.com ',
        kind: 'call',
        from: '2026-10-01',
        to: '2026-10-13',
      }),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.filters).toEqual({
      missionId: 'm-1',
      user: 'ada@example.com',
      accountId: 'c-1',
      tool: 'github__get_file',
      decision: 'refused',
      agentLabel: 'planner',
      tokenHolder: 'bob@example.com',
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

  it('leaves the position to the pager: a cursor is not a filter', () => {
    const cursor = encodeCursor({ ts: '2026-10-13T09:00:00.000Z', id: '0199-abc' });
    expect(parseAuditQuery({ cursor, after: cursor, at: '51' })).toEqual({
      filters: EMPTY,
      raw: {},
      problems: [],
    });
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

describe('a token holder in a query string', () => {
  it('round-trips a member and a named token', () => {
    for (const holder of [
      { kind: 'member', key: '01a135f1-6564-71f6-b1e2-3a4cd1988ce5' },
      { kind: 'named', key: 'CI runner' },
      { kind: 'named', key: 'build-box_2.eu' },
    ] as const) {
      expect(parseHolderParam(holderParam(holder))).toEqual(holder);
    }
    expect(holderParam({ kind: 'named', key: 'CI runner' })).toBe('named:CI runner');
  });

  it('names nobody for anything else', () => {
    for (const value of [
      '',
      'member',
      'member:',
      ':x',
      'robot:x',
      'bob@example.com',
      'CI runner',
    ]) {
      expect(parseHolderParam(value), value).toBeNull();
    }
  });
});

describe('auditQueryString', () => {
  it('keeps the filters and drops the position', () => {
    const { raw } = parseAuditQuery({
      mission: 'm-1',
      decision: 'refused',
      cursor: encodeCursor({ ts: '2026-10-13T09:00:00.000Z', id: 'a' }),
    });
    expect(auditQueryString(raw)).toBe('mission=m-1&decision=refused');
  });
});

describe('scopeOf — the visibility rule', () => {
  const user = { id: 'u-1' };

  it('a user: the missions they created or are a member of, the accounts they and their groups own', () => {
    expect(
      scopeOf({ kind: 'user', user, groups: [{ id: 'g-1' }, { id: 'g-2' }], isOperator: false }),
    ).toEqual({
      missionCreatorUserId: 'u-1',
      missionMemberUserId: 'u-1',
      accountOwners: [
        { kind: 'user', id: 'u-1' },
        { kind: 'group', id: 'g-1' },
        { kind: 'group', id: 'g-2' },
      ],
      allAdmin: false,
      allCalls: false,
    });
  });

  it('an operator: the same, and every entry — administrative acts and calls', () => {
    expect(scopeOf({ kind: 'user', user, groups: [], isOperator: true })).toEqual({
      missionCreatorUserId: 'u-1',
      missionMemberUserId: 'u-1',
      accountOwners: [{ kind: 'user', id: 'u-1' }],
      allAdmin: true,
      allCalls: true,
    });
  });

  it('the bootstrap operator: administrative entries only, never a call', () => {
    expect(scopeOf({ kind: 'bootstrap' })).toEqual({
      missionCreatorUserId: null,
      missionMemberUserId: null,
      accountOwners: [],
      allAdmin: true,
      allCalls: false,
    });
  });
});

describe('standingOn — who is shown the argument fingerprint', () => {
  const ada: AuditViewer = { kind: 'user', user: { id: 'ada' }, groups: [], isOperator: false };
  const mission = { creatorUserId: 'ada' };
  const theirs = { creatorUserId: 'bob' };
  const owned = { owner: { kind: 'user', id: 'ada' } } as const;
  const groupOwned = { owner: { kind: 'group', id: 'g-1' } } as const;

  it('the creator of the mission and an owner of the account answer for the call', () => {
    expect(standingOn(ada, mission, null)).toBe('responsible');
    expect(standingOn(ada, theirs, owned)).toBe('responsible');
    expect(standingOn({ ...ada, groups: [{ id: 'g-1' }] }, theirs, groupOwned)).toBe('responsible');
  });

  it('anybody else who was given the entry is a reader: a member, an operator, the bootstrap', () => {
    expect(standingOn(ada, theirs, null)).toBe('reader');
    expect(standingOn(ada, theirs, groupOwned)).toBe('reader');
    expect(standingOn(ada, null, null)).toBe('reader');
    expect(standingOn({ ...ada, isOperator: true }, theirs, groupOwned)).toBe('reader');
    expect(standingOn({ kind: 'bootstrap' }, mission, owned)).toBe('reader');
  });

  it('being an operator takes nothing from somebody who also answers for the call', () => {
    expect(standingOn({ ...ada, isOperator: true }, mission, null)).toBe('responsible');
  });
});

describe('withoutArguments — a reader is not shown the fingerprint either', () => {
  it('hides fingerprint keys for a reader, at any depth, and shows them to who answers for the call', () => {
    const after = {
      tool: 'github__merge',
      fingerprint: 'f'.repeat(64),
      nested: { arguments_hash: 'a'.repeat(64), Arguments_Fingerprint: 'b'.repeat(64) },
      arguments: { x: 1 },
    };
    expect(withoutArguments(after, 'reader')).toEqual({
      tool: 'github__merge',
      fingerprint: ARGUMENTS_NOT_SHOWN,
      nested: { arguments_hash: ARGUMENTS_NOT_SHOWN, Arguments_Fingerprint: ARGUMENTS_NOT_SHOWN },
      arguments: ARGUMENTS_NOT_SHOWN,
    });
    expect(withoutArguments(after, 'responsible')).toEqual({
      tool: 'github__merge',
      fingerprint: 'f'.repeat(64),
      nested: { arguments_hash: 'a'.repeat(64), Arguments_Fingerprint: 'b'.repeat(64) },
      arguments: ARGUMENTS_NOT_SHOWN,
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
