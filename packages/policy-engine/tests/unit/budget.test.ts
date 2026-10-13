/**
 * The budget rule (spec §3.2 : "always numbers, never unbounded") — the one
 * function the YAML loader, `presetIssues` and the issuance preview share.
 */
import { describe, expect, test } from 'vitest';

import {
  budgetIssues,
  exceedsRateCeiling,
  isPositiveInteger,
  isValidBudget,
  ratePerMinute,
  type BudgetInput,
} from '../../src/budget.ts';

const legal: BudgetInput = {
  quota: 100,
  rate_limit: { max: 30, window_seconds: 60 },
  gate: 'auto',
};

describe('isPositiveInteger', () => {
  test('whole numbers of at least 1 only', () => {
    for (const ok of [1, 2, 1_000_000]) expect(isPositiveInteger(ok)).toBe(true);
    for (const bad of [0, -1, 1.5, Infinity, -Infinity, NaN, '1', null, undefined, {}, [1]]) {
      expect(isPositiveInteger(bad)).toBe(false);
    }
  });
});

describe('budgetIssues', () => {
  test('a legal budget has no issue, with either gate', () => {
    expect(budgetIssues(legal)).toEqual([]);
    expect(budgetIssues({ ...legal, gate: 'approval' })).toEqual([]);
    expect(isValidBudget(legal)).toBe(true);
  });

  test.each([Infinity, 0, -3, 1.5, NaN, '100', null, undefined])('quota %s is refused', (quota) => {
    expect(budgetIssues({ ...legal, quota })).toEqual([
      { field: 'quota', message: 'expected a positive integer (no infinite budget, spec §3.2)' },
    ]);
    expect(isValidBudget({ ...legal, quota })).toBe(false);
  });

  test('each member of the rate limit is a positive integer', () => {
    expect(budgetIssues({ ...legal, rate_limit: { max: -1, window_seconds: 0 } })).toEqual([
      { field: 'rate_limit.max', message: 'expected a positive integer' },
      { field: 'rate_limit.window_seconds', message: 'expected a positive integer' },
    ]);
    expect(budgetIssues({ ...legal, rate_limit: { max: Infinity, window_seconds: 60 } })).toEqual([
      { field: 'rate_limit.max', message: 'expected a positive integer' },
    ]);
    expect(budgetIssues({ ...legal, rate_limit: { max: 1 } })).toEqual([
      { field: 'rate_limit.window_seconds', message: 'expected a positive integer' },
    ]);
  });

  test.each([undefined, null, 30, 'fast', [30, 60]])(
    'rate limit %j is not { max, window_seconds }',
    (rate_limit) => {
      expect(budgetIssues({ ...legal, rate_limit })).toEqual([
        { field: 'rate_limit', message: 'expected { max, window_seconds }' },
      ]);
    },
  );

  test.each(['whatever', 'confirm', '', undefined, null, true])('gate %j is refused', (gate) => {
    expect(budgetIssues({ ...legal, gate })).toEqual([
      { field: 'gate', message: 'expected one of auto | approval' },
    ]);
  });

  test('every illegal field is listed, in field order', () => {
    expect(
      budgetIssues({
        quota: Infinity,
        rate_limit: { max: -1, window_seconds: 0 },
        gate: 'whatever',
      }).map((issue) => issue.field),
    ).toEqual(['quota', 'rate_limit.max', 'rate_limit.window_seconds', 'gate']);
  });
});

describe('ratePerMinute / exceedsRateCeiling', () => {
  test('the rate is normalised to one minute', () => {
    expect(ratePerMinute({ max: 30, window_seconds: 60 })).toBe(30);
    expect(ratePerMinute({ max: 1, window_seconds: 1 })).toBe(60);
    expect(ratePerMinute({ max: 10, window_seconds: 600 })).toBe(1);
  });

  test('strictly above the ceiling exceeds ; no ceiling never does', () => {
    expect(exceedsRateCeiling({ max: 31, window_seconds: 60 }, 30)).toBe(true);
    expect(exceedsRateCeiling({ max: 30, window_seconds: 60 }, 30)).toBe(false);
    expect(exceedsRateCeiling({ max: 1, window_seconds: 1 }, 30)).toBe(true);
    expect(exceedsRateCeiling({ max: 1_000_000, window_seconds: 1 }, null)).toBe(false);
    expect(exceedsRateCeiling({ max: 1_000_000, window_seconds: 1 }, undefined)).toBe(false);
  });
});
