/**
 * Mission state derivation (spec §2.3: `exhausted` per risk, `expired` from the
 * expiry, the stored statuses; §3.3 rollover on read).
 */
import type { MissionPolicy } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';
import {
  consumedInPeriod,
  deriveMissionState,
  type MissionStateInput,
  type PeriodCounter,
} from '../../../../src/server/budget/index.ts';

const SET = 'set-1';
/** The key of a line of the mission's one set. */
const L = (riskId: string) => `${SET}::${riskId}` as const;

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';
const ANCHOR = '2026-10-13T00:00:00.000Z';
const DAY1 = '2026-10-14T00:00:00.000Z';

const POLICY: MissionPolicy = [
  {
    resource_set_id: SET,
    risk_id: READ,
    quota: 10,
    rate_limit: { max: 5, window_seconds: 60 },
    gate: 'auto',
  },
  {
    resource_set_id: SET,
    risk_id: WRITE,
    quota: 1,
    rate_limit: { max: 5, window_seconds: 60 },
    gate: 'auto',
  },
];

function mission(overrides: Partial<MissionStateInput> = {}): MissionStateInput {
  return {
    status: 'active',
    expires_at: null,
    period: { anchor_at: ANCHOR, length_seconds: 86_400 },
    policy: POLICY,
    ...overrides,
  };
}

const counter = (risk_id: string, period_start: string, consumed: number): PeriodCounter => ({
  resource_set_id: SET,
  risk_id,
  period_start,
  consumed,
});

describe('deriveMissionState', () => {
  it('stored terminal statuses win over everything else', () => {
    const counters = [counter(WRITE, ANCHOR, 1)];
    const now = new Date('2026-10-13T12:00:00.000Z');
    expect(deriveMissionState(mission({ status: 'revoked' }), counters, now)).toEqual({
      kind: 'revoked',
    });
    expect(deriveMissionState(mission({ status: 'orphaned' }), counters, now)).toEqual({
      kind: 'orphaned',
    });
    expect(
      deriveMissionState(mission({ status: 'expired', expires_at: ANCHOR }), counters, now),
    ).toEqual({ kind: 'expired', expires_at: ANCHOR });
  });

  it('an active mission past its expiry reads expired without any column flip', () => {
    const state = deriveMissionState(
      mission({ expires_at: '2026-10-13T10:00:00.000Z' }),
      [],
      new Date('2026-10-13T10:00:00.000Z'),
    );
    expect(state).toEqual({ kind: 'expired', expires_at: '2026-10-13T10:00:00.000Z' });
  });

  it('active: exhausted per risk, remaining per risk, for the current period only', () => {
    const state = deriveMissionState(
      mission(),
      [counter(READ, ANCHOR, 4), counter(WRITE, ANCHOR, 1)],
      new Date('2026-10-13T12:00:00.000Z'),
    );
    expect(state).toEqual({
      kind: 'active',
      period: { index: 0, start: ANCHOR, end: DAY1 },
      exhausted: [L(WRITE)],
      remaining: { [L(READ)]: 6, [L(WRITE)]: 0 },
    });
  });

  it('rollover on read: yesterday’s exhaustion is gone today', () => {
    const state = deriveMissionState(
      mission(),
      [counter(WRITE, ANCHOR, 1)],
      new Date('2026-10-14T00:00:00.000Z'),
    );
    expect(state).toMatchObject({
      kind: 'active',
      period: { index: 1, start: DAY1 },
      exhausted: [],
      remaining: { [L(READ)]: 10, [L(WRITE)]: 1 },
    });
  });

  it('a one-off mission never reloads: exhausted stays exhausted', () => {
    const state = deriveMissionState(
      mission({ period: { anchor_at: ANCHOR, length_seconds: null } }),
      [counter(WRITE, ANCHOR, 1)],
      new Date('2027-06-01T00:00:00.000Z'),
    );
    expect(state).toMatchObject({ kind: 'active', period: { end: null }, exhausted: [L(WRITE)] });
  });

  it('a quota raised below what was already consumed does not report negative remaining', () => {
    const state = deriveMissionState(
      mission({
        policy: [
          {
            resource_set_id: SET,
            risk_id: READ,
            quota: 2,
            rate_limit: { max: 5, window_seconds: 60 },
            gate: 'auto',
          },
        ],
      }),
      [counter(READ, ANCHOR, 5)],
      new Date('2026-10-13T12:00:00.000Z'),
    );
    expect(state).toMatchObject({ exhausted: [L(READ)], remaining: { [L(READ)]: 0 } });
  });
});

describe('consumedInPeriod', () => {
  it('sums the counters of one period and ignores the others', () => {
    const consumed = consumedInPeriod(
      [counter(READ, ANCHOR, 2), counter(READ, ANCHOR, 3), counter(READ, DAY1, 7)],
      ANCHOR,
    );
    expect([...consumed]).toEqual([[L(READ), 5]]);
  });

  it('keeps two resource sets apart: a risk counted in each is two lines', () => {
    const consumed = consumedInPeriod(
      [counter(READ, ANCHOR, 2), { ...counter(READ, ANCHOR, 4), resource_set_id: 'set-2' }],
      ANCHOR,
    );
    expect([...consumed]).toEqual([
      [L(READ), 2],
      [`set-2::${READ}`, 4],
    ]);
  });
});
