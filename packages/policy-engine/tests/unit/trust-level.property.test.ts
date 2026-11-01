/**
 * Properties of the budget a trust level writes (risk model §4.6): the rate stays
 * within the catalog's per-minute ceiling and never falls under one call per
 * window, and a more trusting level never gives less.
 *
 * Seeded and replayable: FC_SEED, FC_RUNS.
 */
import type { Budget } from '@vaubaan/shared';
import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  budgetAtTrustLevel,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVELS,
} from '../../src/trust-level.ts';

const RUNS = {
  seed: Number(process.env.FC_SEED ?? 20_261_031),
  numRuns: Number(process.env.FC_RUNS ?? 300),
};
const SECONDS_PER_MINUTE = 60;

const base: fc.Arbitrary<Budget> = fc.record({
  quota: fc.integer({ min: 1, max: 10_000 }),
  rate_limit: fc.record({
    max: fc.integer({ min: 1, max: 1_000 }),
    window_seconds: fc.constantFrom(1, 10, 60, 300, 3_600, 86_400),
  }),
});
const ceiling = fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null });
const level = fc.constantFrom(...TRUST_LEVELS);

describe('budget at a trust level', () => {
  it('never exceeds the ceiling a catalog declares, and never falls under one call', () => {
    fc.assert(
      fc.property(base, level, ceiling, (b, l, perMinute) => {
        const { rate_limit } = budgetAtTrustLevel(b, l, perMinute);
        if (rate_limit.max < 1) return false;
        if (rate_limit.window_seconds !== b.rate_limit.window_seconds) return false;
        if (perMinute === null)
          return rate_limit.max === b.rate_limit.max * TRUST_LEVEL_BUDGET_FACTOR[l];
        const cap = Math.floor((perMinute * b.rate_limit.window_seconds) / SECONDS_PER_MINUTE);
        return rate_limit.max <= Math.max(1, cap);
      }),
      RUNS,
    );
  });

  it('multiplies the quota by the level’s factor, whatever the ceiling', () => {
    fc.assert(
      fc.property(
        base,
        level,
        ceiling,
        (b, l, perMinute) =>
          budgetAtTrustLevel(b, l, perMinute).quota === b.quota * TRUST_LEVEL_BUDGET_FACTOR[l],
      ),
      RUNS,
    );
  });

  it('gives no less at a more trusting level', () => {
    fc.assert(
      fc.property(base, ceiling, (b, perMinute) => {
        const budgets = TRUST_LEVELS.map((l) => budgetAtTrustLevel(b, l, perMinute));
        return budgets.every(
          (budget, i) =>
            i === 0 ||
            (budget.quota >= (budgets[i - 1]?.quota ?? 0) &&
              budget.rate_limit.max >= (budgets[i - 1]?.rate_limit.max ?? 0)),
        );
      }),
      RUNS,
    );
  });
});
