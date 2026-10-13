/**
 * The pure budget decision (spec §3.2 unit / quota / rate limit, §3.5 gate, §10
 * "multi-risk decrement", "whole refusal of a multi-risk call").
 */
import type { MissionPolicy, RiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';
import {
  BudgetInvariantError,
  decide,
  type CurrentPeriod,
  type DecideInput,
  type RateProbe,
} from '../../../../src/server/budget/index.ts';

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';
const MERGE = 'github.merge-protected';

const PERIOD: CurrentPeriod = {
  index: 0,
  start: '2026-10-13T00:00:00.000Z',
  end: '2026-10-14T00:00:00.000Z',
};

const POLICY: MissionPolicy = [
  { risk_id: READ, quota: 10, rate_limit: { max: 5, window_seconds: 60 }, gate: 'auto' },
  { risk_id: WRITE, quota: 1, rate_limit: { max: 5, window_seconds: 60 }, gate: 'auto' },
  { risk_id: MERGE, quota: 2, rate_limit: { max: 1, window_seconds: 60 }, gate: 'approval' },
];

const FP = 'f'.repeat(64);

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    policy: POLICY,
    risks_touched: [READ],
    counters: new Map(),
    rate_windows: new Map(),
    period: PERIOD,
    fingerprint: FP,
    ...overrides,
  };
}

const counters = (c: Record<string, number>) => new Map<RiskId, number>(Object.entries(c));
const windows = (w: Record<string, RateProbe>) => new Map<RiskId, RateProbe>(Object.entries(w));

describe('decide — allow', () => {
  it('a call touching N risks decrements N counters, one per distinct risk', () => {
    const outcome = decide(input({ risks_touched: [READ, WRITE, READ] }));
    expect(outcome).toEqual({
      kind: 'allow',
      decrements: [READ, WRITE],
      remaining: { [READ]: 9, [WRITE]: 0 },
      approvals_to_consume: [],
    });
  });

  it('a call touching no risk is allowed and decrements nothing', () => {
    expect(decide(input({ risks_touched: [] }))).toEqual({
      kind: 'allow',
      decrements: [],
      remaining: {},
      approvals_to_consume: [],
    });
  });

  it('remaining accounts for what was already consumed this period', () => {
    const outcome = decide(input({ risks_touched: [READ], counters: counters({ [READ]: 7 }) }));
    expect(outcome).toMatchObject({ kind: 'allow', remaining: { [READ]: 2 } });
  });

  it('a gated risk with a matching approval is allowed and names the approval to consume', () => {
    const outcome = decide(
      input({ risks_touched: [MERGE, READ], approvals: new Map([[MERGE, 'apr_1']]) }),
    );
    expect(outcome).toMatchObject({
      kind: 'allow',
      decrements: [MERGE, READ],
      approvals_to_consume: [{ risk_id: MERGE, approval_id: 'apr_1' }],
    });
  });

  it('a gate the creator opened for the period behaves as auto', () => {
    const outcome = decide(input({ risks_touched: [MERGE], opened_gates: new Set([MERGE]) }));
    expect(outcome).toMatchObject({ kind: 'allow', approvals_to_consume: [] });
  });
});

describe('decide — refuse', () => {
  it('budget-exhausted when the consumed count reached the quota', () => {
    const outcome = decide(input({ risks_touched: [WRITE], counters: counters({ [WRITE]: 1 }) }));
    expect(outcome).toEqual({
      kind: 'refuse',
      code: 'budget-exhausted',
      risk_id: WRITE,
      details: { quota: 1, consumed: 1, period_end: PERIOD.end },
    });
  });

  it('a one-off mission reports no period end', () => {
    const outcome = decide(
      input({
        risks_touched: [WRITE],
        counters: counters({ [WRITE]: 1 }),
        period: { index: 0, start: PERIOD.start, end: null },
      }),
    );
    expect(outcome).toMatchObject({ code: 'budget-exhausted', details: { period_end: null } });
  });

  it('whole-call refusal: one exhausted risk refuses a call that touches others too', () => {
    const outcome = decide(
      input({ risks_touched: [READ, WRITE], counters: counters({ [READ]: 0, [WRITE]: 1 }) }),
    );
    expect(outcome).toMatchObject({ kind: 'refuse', code: 'budget-exhausted', risk_id: WRITE });
  });

  it('rate-limited when the sliding window is full, with at least one second to wait', () => {
    const outcome = decide(
      input({
        risks_touched: [READ],
        rate_windows: windows({ [READ]: { count: 5, retry_after_seconds: 0 } }),
      }),
    );
    expect(outcome).toEqual({
      kind: 'refuse',
      code: 'rate-limited',
      risk_id: READ,
      details: { limit: { max: 5, window_seconds: 60 }, retry_after_seconds: 1 },
    });
    const later = decide(
      input({
        risks_touched: [READ],
        rate_windows: windows({ [READ]: { count: 5, retry_after_seconds: 37 } }),
      }),
    );
    expect(later).toMatchObject({ details: { retry_after_seconds: 37 } });
  });

  it('approval-required for a gated risk without approval, carrying the fingerprint', () => {
    expect(decide(input({ risks_touched: [MERGE] }))).toEqual({
      kind: 'refuse',
      code: 'approval-required',
      risk_id: MERGE,
      details: { fingerprint: FP, gated_risks: [MERGE] },
    });
  });

  describe('a call touching several gated risks', () => {
    const GATED: MissionPolicy = POLICY.map((entry) =>
      entry.risk_id === WRITE ? { ...entry, gate: 'approval' } : entry,
    );
    const both = (overrides: Partial<DecideInput> = {}) =>
      decide(input({ policy: GATED, risks_touched: [WRITE, READ, MERGE], ...overrides }));

    it('is refused once, naming every gated risk in call order: one request covers the call', () => {
      expect(both()).toEqual({
        kind: 'refuse',
        code: 'approval-required',
        risk_id: WRITE,
        details: { fingerprint: FP, gated_risks: [WRITE, MERGE] },
      });
    });

    it('with an approval for one of them only, still lists them all and names the one not covered', () => {
      expect(both({ approvals: new Map([[WRITE, 'apr_w']]) })).toEqual({
        kind: 'refuse',
        code: 'approval-required',
        risk_id: MERGE,
        details: { fingerprint: FP, gated_risks: [WRITE, MERGE] },
      });
    });

    it('is allowed by one approval standing under every gated risk, or by one approval each', () => {
      const whole = new Map([
        [WRITE, 'apr_call'],
        [MERGE, 'apr_call'],
      ]);
      expect(both({ approvals: whole })).toMatchObject({
        kind: 'allow',
        decrements: [WRITE, READ, MERGE],
        approvals_to_consume: [
          { risk_id: WRITE, approval_id: 'apr_call' },
          { risk_id: MERGE, approval_id: 'apr_call' },
        ],
      });
      const each = new Map([
        [WRITE, 'apr_w'],
        [MERGE, 'apr_m'],
      ]);
      expect(both({ approvals: each })).toMatchObject({
        kind: 'allow',
        approvals_to_consume: [
          { risk_id: WRITE, approval_id: 'apr_w' },
          { risk_id: MERGE, approval_id: 'apr_m' },
        ],
      });
    });

    it('a gate opened for the period is not asked about, and not listed', () => {
      expect(both({ opened_gates: new Set([WRITE]) })).toEqual({
        kind: 'refuse',
        code: 'approval-required',
        risk_id: MERGE,
        details: { fingerprint: FP, gated_risks: [MERGE] },
      });
      expect(both({ opened_gates: new Set([WRITE, MERGE]) })).toMatchObject({
        kind: 'allow',
        approvals_to_consume: [],
      });
    });

    it('an approval for a risk the call does not gate is not consumed', () => {
      const outcome = decide(
        input({
          policy: GATED,
          risks_touched: [MERGE],
          approvals: new Map([
            [MERGE, 'apr_m'],
            [WRITE, 'apr_w'],
          ]),
        }),
      );
      expect(outcome).toMatchObject({
        kind: 'allow',
        approvals_to_consume: [{ risk_id: MERGE, approval_id: 'apr_m' }],
      });
    });
  });

  it('a multi-risk call with one gated risk is refused as a whole, even if the others are fine', () => {
    const outcome = decide(input({ risks_touched: [READ, MERGE] }));
    expect(outcome).toMatchObject({ kind: 'refuse', code: 'approval-required', risk_id: MERGE });
  });

  it('checks quota before rate before gate across all risks (no approval asked for a dead call)', () => {
    // MERGE is gated and has no approval, READ is exhausted: the budget wins.
    const exhausted = decide(
      input({ risks_touched: [MERGE, READ], counters: counters({ [READ]: 10 }) }),
    );
    expect(exhausted).toMatchObject({ code: 'budget-exhausted', risk_id: READ });
    // MERGE is gated and has no approval, READ is rate-limited: the rate wins.
    const limited = decide(
      input({
        risks_touched: [MERGE, READ],
        rate_windows: windows({ [READ]: { count: 5, retry_after_seconds: 3 } }),
      }),
    );
    expect(limited).toMatchObject({ code: 'rate-limited', risk_id: READ });
  });

  it('an approval on a gated risk does not bypass its own quota or rate', () => {
    const approvals = new Map([[MERGE, 'apr_1']]);
    expect(
      decide(input({ risks_touched: [MERGE], counters: counters({ [MERGE]: 2 }), approvals })),
    ).toMatchObject({ code: 'budget-exhausted', risk_id: MERGE });
    expect(
      decide(
        input({
          risks_touched: [MERGE],
          rate_windows: windows({ [MERGE]: { count: 1, retry_after_seconds: 10 } }),
          approvals,
        }),
      ),
    ).toMatchObject({ code: 'rate-limited', risk_id: MERGE });
  });
});

describe('decide — invariants', () => {
  it('a touched risk absent from the policy is an invariant violation, not a refusal', () => {
    expect(() => decide(input({ risks_touched: ['stripe.refund'] }))).toThrow(BudgetInvariantError);
  });

  it('does not mutate its inputs', () => {
    const c = counters({ [READ]: 1 });
    const risks = [READ, READ];
    decide(input({ risks_touched: risks, counters: c }));
    expect(c.get(READ)).toBe(1);
    expect(risks).toEqual([READ, READ]);
  });
});
