import { describe, expect, it } from 'vitest';

import type { CallTotalsRow } from '../store';
import { parseOverviewPeriod, sinceOf, totalsByMission } from './overview';

const row = (over: Partial<CallTotalsRow>): CallTotalsRow => ({
  missionId: 'mis_1',
  accountId: 'acc_1',
  kind: 'member',
  holder: 'usr_ada',
  allowed: 0,
  refused: 0,
  requestBytes: 0,
  responseBytes: 0,
  ...over,
});

describe('totalsByMission', () => {
  it('sums the rows of a mission in total, per account and per holder', () => {
    const totals = totalsByMission([
      row({ allowed: 3, refused: 1, requestBytes: 100, responseBytes: 1_000 }),
      row({ accountId: 'acc_2', allowed: 2, requestBytes: 10, responseBytes: 20 }),
      row({ kind: 'named', holder: 'ci', allowed: 4, responseBytes: 5 }),
      row({ missionId: 'mis_2', allowed: 7 }),
    ]);
    const one = totals.get('mis_1');
    expect(one?.total).toEqual({
      allowed: 9,
      refused: 1,
      request_bytes: 110,
      response_bytes: 1_025,
    });
    expect(one?.byAccount.get('acc_1')).toEqual({
      allowed: 7,
      refused: 1,
      request_bytes: 100,
      response_bytes: 1_005,
    });
    expect(one?.byAccount.get('acc_2')?.allowed).toBe(2);
    expect(one?.byHolder.get('member:usr_ada')).toMatchObject({ allowed: 5, refused: 1 });
    expect(one?.byHolder.get('named:ci')).toMatchObject({
      kind: 'named',
      holder: 'ci',
      allowed: 4,
    });
    expect(totals.get('mis_2')?.total.allowed).toBe(7);
  });

  it('counts a call refused before its account was resolved in the total only', () => {
    const one = totalsByMission([row({ accountId: null, refused: 2 })]).get('mis_1');
    expect(one?.total.refused).toBe(2);
    expect(one?.byAccount.size).toBe(0);
  });

  it('gathers the calls written before keys had a holder under one entry', () => {
    const one = totalsByMission([
      row({ kind: null, holder: null, allowed: 1 }),
      row({ kind: null, holder: null, allowed: 2 }),
    ]).get('mis_1');
    expect([...(one?.byHolder.values() ?? [])]).toEqual([
      { kind: null, holder: null, allowed: 3, refused: 0, request_bytes: 0, response_bytes: 0 },
    ]);
  });
});

describe('the span of the Overview', () => {
  const now = new Date('2026-11-15T15:30:00.000Z');

  it('starts at midnight UTC today, or 7 or 30 days back', () => {
    expect(sinceOf('today', now).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(sinceOf('7d', now).toISOString()).toBe('2026-11-08T15:30:00.000Z');
    expect(sinceOf('30d', now).toISOString()).toBe('2026-10-16T15:30:00.000Z');
  });

  it('reads the period from the address, 7 days for anything else', () => {
    expect(parseOverviewPeriod({ period: 'today' })).toBe('today');
    expect(parseOverviewPeriod({ period: ['30d', 'today'] })).toBe('30d');
    expect(parseOverviewPeriod({ period: 'year' })).toBe('7d');
    expect(parseOverviewPeriod({})).toBe('7d');
  });
});
