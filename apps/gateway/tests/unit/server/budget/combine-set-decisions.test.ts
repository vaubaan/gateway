/**
 * Combining the per-set budget decisions of one call (risk model §4.7): every set is
 * charged, the order stays dimension-major across the sets, an approval covers every
 * gated line.
 */
import { describe, expect, it } from 'vitest';

import {
  BudgetInvariantError,
  combineSetDecisions,
  decide,
  type CurrentPeriod,
  type DecideInput,
} from '../../../../src/server/budget/index.ts';

const READ = 'twin.read';
const WRITE = 'twin.write';
const PERIOD: CurrentPeriod = {
  index: 0,
  start: '2026-10-13T00:00:00.000Z',
  end: '2026-10-14T00:00:00.000Z',
};
const RATE = { max: 5, window_seconds: 60 };

function inSet(overrides: Partial<DecideInput>): DecideInput {
  return {
    policy: [
      { risk_id: READ, quota: 10, rate_limit: RATE, gate: 'auto' },
      { risk_id: WRITE, quota: 10, rate_limit: RATE, gate: 'auto' },
    ],
    risks_touched: [READ, WRITE],
    counters: new Map(),
    rate_windows: new Map(),
    period: PERIOD,
    fingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

describe('combineSetDecisions', () => {
  it('charges every set and keeps each line’s remaining budget', () => {
    const combined = combineSetDecisions([
      { resource_set_id: 's1', outcome: decide(inSet({})) },
      {
        resource_set_id: 's2',
        outcome: decide(inSet({ counters: new Map([[READ, 8]]) })),
      },
    ]);
    expect(combined).toMatchObject({
      kind: 'allow',
      decrements: [
        { resource_set_id: 's1', risk_id: READ },
        { resource_set_id: 's1', risk_id: WRITE },
        { resource_set_id: 's2', risk_id: READ },
        { resource_set_id: 's2', risk_id: WRITE },
      ],
      remaining: { [`s1::${READ}`]: 9, [`s2::${READ}`]: 1, [`s2::${WRITE}`]: 9 },
    });
  });

  it('refuses on quota in any set before asking an approval in another', () => {
    const gated = decide(
      inSet({
        policy: [
          { risk_id: READ, quota: 10, rate_limit: RATE, gate: 'approval' },
          { risk_id: WRITE, quota: 10, rate_limit: RATE, gate: 'auto' },
        ],
      }),
    );
    const spent = decide(inSet({ counters: new Map([[WRITE, 10]]) }));
    const combined = combineSetDecisions([
      { resource_set_id: 's1', outcome: gated },
      { resource_set_id: 's2', outcome: spent },
    ]);
    expect(combined).toMatchObject({
      kind: 'refuse',
      code: 'budget-exhausted',
      resource_set_id: 's2',
    });
  });

  it('asks one approval for every gated line of every set', () => {
    const gate = (risk: string) =>
      decide(
        inSet({
          policy: [
            {
              risk_id: READ,
              quota: 10,
              rate_limit: RATE,
              gate: risk === READ ? 'approval' : 'auto',
            },
            {
              risk_id: WRITE,
              quota: 10,
              rate_limit: RATE,
              gate: risk === WRITE ? 'approval' : 'auto',
            },
          ],
        }),
      );
    const combined = combineSetDecisions([
      { resource_set_id: 's1', outcome: gate(READ) },
      { resource_set_id: 's2', outcome: gate(WRITE) },
    ]);
    expect(combined).toMatchObject({
      kind: 'refuse',
      code: 'approval-required',
      gated_lines: [
        { resource_set_id: 's1', risk_id: READ },
        { resource_set_id: 's2', risk_id: WRITE },
      ],
    });
    expect(combined.kind === 'refuse' && combined.details).toMatchObject({
      gated_risks: [READ, WRITE],
    });
  });

  it('fails closed on a call charged on no set', () => {
    expect(() => combineSetDecisions([])).toThrow(BudgetInvariantError);
  });
});
