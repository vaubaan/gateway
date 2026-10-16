/**
 * Period arithmetic (spec §3.3 "rollover computed on read"; plan §3.5 "reload is pure
 * arithmetic on (anchor, length, now)").
 */
import { describe, expect, it } from 'vitest';
import {
  BudgetInvariantError,
  currentPeriod,
  periodIndex,
  periodSpecOf,
} from '../../../../src/server/budget/index.ts';

const ANCHOR = '2026-10-13T00:00:00.000Z';
const DAY = 86_400;
const at = (iso: string) => new Date(iso);

describe('periodIndex', () => {
  it('counts whole periods elapsed since the anchor', () => {
    expect(periodIndex(ANCHOR, DAY, at('2026-10-13T00:00:00.000Z'))).toBe(0);
    expect(periodIndex(ANCHOR, DAY, at('2026-10-13T23:59:59.999Z'))).toBe(0);
    expect(periodIndex(ANCHOR, DAY, at('2026-10-14T00:00:00.000Z'))).toBe(1);
    expect(periodIndex(ANCHOR, DAY, at('2026-10-20T12:00:00.000Z'))).toBe(7);
  });

  it('places an instant before the anchor in the first period (clock skew)', () => {
    expect(periodIndex(ANCHOR, DAY, at('2026-10-12T23:59:00.000Z'))).toBe(0);
  });

  it('refuses a non-positive or fractional length and a malformed anchor', () => {
    expect(() => periodIndex(ANCHOR, 0, at(ANCHOR))).toThrow(BudgetInvariantError);
    expect(() => periodIndex(ANCHOR, -60, at(ANCHOR))).toThrow(BudgetInvariantError);
    expect(() => periodIndex(ANCHOR, 1.5, at(ANCHOR))).toThrow(BudgetInvariantError);
    expect(() => periodIndex('yesterday', DAY, at(ANCHOR))).toThrow(BudgetInvariantError);
  });
});

describe('currentPeriod', () => {
  it('a recurring mission: start is the counters key, end is the reload instant', () => {
    const period = currentPeriod(
      { anchor_at: ANCHOR, length_seconds: DAY },
      at('2026-10-15T08:30:00.000Z'),
    );
    expect(period).toEqual({
      index: 2,
      start: '2026-10-15T00:00:00.000Z',
      end: '2026-10-16T00:00:00.000Z',
    });
  });

  it('a one-off mission: a single open-ended period starting at the anchor', () => {
    const spec = { anchor_at: '2026-10-13T09:15:00.000Z', length_seconds: null };
    expect(currentPeriod(spec, at('2026-10-13T09:15:00.000Z'))).toEqual({
      index: 0,
      start: '2026-10-13T09:15:00.000Z',
      end: null,
    });
    expect(currentPeriod(spec, at('2031-01-01T00:00:00.000Z')).start).toBe(
      '2026-10-13T09:15:00.000Z',
    );
  });

  it('normalizes the anchor to canonical ISO so the key is stable whatever its spelling', () => {
    const period = currentPeriod(
      { anchor_at: '2026-10-13T02:00:00+02:00', length_seconds: 3600 },
      at('2026-10-13T00:30:00.000Z'),
    );
    expect(period.start).toBe('2026-10-13T00:00:00.000Z');
    expect(period.end).toBe('2026-10-13T01:00:00.000Z');
  });

  it('the period boundary belongs to the next period', () => {
    const spec = { anchor_at: ANCHOR, length_seconds: 3600 };
    expect(currentPeriod(spec, at('2026-10-13T00:59:59.999Z')).index).toBe(0);
    expect(currentPeriod(spec, at('2026-10-13T01:00:00.000Z')).index).toBe(1);
  });
});

describe('periodSpecOf', () => {
  it('maps the shared Period, borrowing the stored anchor for a one-off mission', () => {
    expect(
      periodSpecOf({ kind: 'recurring', length_seconds: 600, anchor_at: ANCHOR }, 'ignored'),
    ).toEqual({ anchor_at: ANCHOR, length_seconds: 600 });
    expect(periodSpecOf({ kind: 'one-off' }, ANCHOR)).toEqual({
      anchor_at: ANCHOR,
      length_seconds: null,
    });
  });
});
