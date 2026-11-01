/**
 * Gates opened for the rest of the period (spec §3.5, §10 "gate opening bounded to
 * the period"): what `decide()` receives as `opened_gates`, derived from the session's
 * `gate-opened` and `gate-changed` events.
 */
import { describe, expect, it } from 'vitest';

import {
  currentPeriod,
  decide,
  GATE_EVENT_KINDS,
  openedGatesOf,
  openedInSet,
  type GateEventLike,
} from '../../../../src/server/budget/index.ts';

const SET = 'set-1';
const OTHER_SET = 'set-2';
const MERGE = 'github.merge-protected';
/** The line of `MERGE` in the mission's first set: what an opening is about. */
const MERGE_LINE = `${SET}::${MERGE}`;
const DEPLOY = 'railway[prod].deploy';
const ANCHOR = '2026-10-13T00:00:00.000Z';
const DAY_SECONDS = 86_400;
const SPEC = { anchor_at: ANCHOR, length_seconds: DAY_SECONDS };

const TODAY = currentPeriod(SPEC, new Date('2026-10-13T09:00:00.000Z'));
const TOMORROW = currentPeriod(SPEC, new Date('2026-10-14T00:00:00.000Z'));

function opened(
  ts: string,
  riskId: string | null = MERGE,
  period = TODAY,
  resourceSetId: string | null = SET,
): GateEventLike {
  return {
    ts,
    kind: 'gate-opened',
    riskId,
    resourceSetId,
    details: { request_id: 'r1', period_start: period.start, period_end: period.end },
  };
}

function changed(
  ts: string,
  gate: 'auto' | 'approval',
  riskId = MERGE,
  resourceSetId: string | null = SET,
): GateEventLike {
  return {
    ts,
    kind: 'gate-changed',
    riskId,
    resourceSetId,
    details: { gate, gate_before: gate === 'auto' ? 'approval' : 'auto' },
  };
}

describe('openedGatesOf', () => {
  it('reads the event kinds that decide a gate, and nothing opens without an event', () => {
    // `permission-removed`: an edit of the mission removed the risk (ADR
    // mission-editable-after-issuance); added again, it asks again.
    expect(GATE_EVENT_KINDS).toEqual(['gate-opened', 'gate-changed', 'permission-removed']);
    expect(openedGatesOf([], TODAY)).toEqual(new Set());
  });

  it('opens the gate of the risk the event names, for the period it carries', () => {
    const events = [opened('2026-10-13T09:00:00.000Z')];
    expect(openedGatesOf(events, TODAY)).toEqual(new Set([MERGE_LINE]));
    // Another risk of the same mission stays gated.
    expect(openedGatesOf(events, TODAY).has(`${SET}::${DEPLOY}`)).toBe(false);
  });

  it('is bounded to the period: at the reload instant the gate is closed again', () => {
    const events = [opened('2026-10-13T23:59:59.999Z')];
    const lastInstant = currentPeriod(SPEC, new Date('2026-10-13T23:59:59.999Z'));
    expect(openedGatesOf(events, lastInstant)).toEqual(new Set([MERGE_LINE]));
    expect(TOMORROW.start).toBe(TODAY.end);
    expect(openedGatesOf(events, TOMORROW)).toEqual(new Set());
  });

  it('an opening granted in the new period opens the new period only', () => {
    const events = [opened('2026-10-14T08:00:00.000Z', MERGE, TOMORROW)];
    expect(openedGatesOf(events, TOMORROW)).toEqual(new Set([MERGE_LINE]));
    expect(openedGatesOf(events, TODAY)).toEqual(new Set());
  });

  it('a later edit of the gate on the mission ends the opening, whatever the new value', () => {
    for (const gate of ['approval', 'auto'] as const) {
      const events = [
        opened('2026-10-13T09:00:00.000Z'),
        changed('2026-10-13T10:00:00.000Z', gate),
      ];
      expect(openedGatesOf(events, TODAY)).toEqual(new Set());
    }
    // An edit of another risk changes nothing here.
    expect(
      openedGatesOf(
        [
          opened('2026-10-13T09:00:00.000Z'),
          changed('2026-10-13T10:00:00.000Z', 'approval', DEPLOY),
        ],
        TODAY,
      ),
    ).toEqual(new Set([MERGE_LINE]));
  });

  it('an edit at the very instant of an opening wins: on a tie the gate stays closed', () => {
    const at = '2026-10-13T09:00:00.000Z';
    expect(openedGatesOf([opened(at), changed(at, 'approval')], TODAY)).toEqual(new Set());
    expect(openedGatesOf([changed(at, 'approval'), opened(at)], TODAY)).toEqual(new Set());
  });

  it('an opening granted after an edit opens again, in any order of the list', () => {
    const events = [
      opened('2026-10-13T11:00:00.000Z'),
      changed('2026-10-13T10:00:00.000Z', 'approval'),
      opened('2026-10-13T09:00:00.000Z'),
    ];
    expect(openedGatesOf(events, TODAY)).toEqual(new Set([MERGE_LINE]));
  });

  it('opens nothing from an event it cannot read', () => {
    const malformed: GateEventLike[] = [
      {
        ts: '2026-10-13T09:00:00.000Z',
        kind: 'gate-opened',
        riskId: MERGE,
        resourceSetId: SET,
        details: null,
      },
      // No period end: a period that never ends bounds nothing.
      {
        ts: '2026-10-13T09:00:00.000Z',
        kind: 'gate-opened',
        riskId: MERGE,
        resourceSetId: SET,
        details: { request_id: 'r1', period_start: TODAY.start, period_end: null },
      },
      // No risk on the event's own column.
      opened('2026-10-13T09:00:00.000Z', null),
      // No resource set: an opening is about one line, never every set of the risk.
      opened('2026-10-13T09:00:00.000Z', MERGE, TODAY, null),
      { ...opened('not-a-date'), ts: 'not-a-date' },
      // Another kind carrying the same details.
      { ...opened('2026-10-13T09:00:00.000Z'), kind: 'request' },
    ];
    expect(openedGatesOf(malformed, TODAY)).toEqual(new Set());
  });

  it('an opening is about one resource set: the same risk in another set stays gated', () => {
    const open = openedGatesOf([opened('2026-10-13T09:00:00.000Z')], TODAY);
    expect(open).toEqual(new Set([MERGE_LINE]));
    expect(openedInSet(open, SET)).toEqual(new Set([MERGE]));
    expect(openedInSet(open, OTHER_SET)).toEqual(new Set());
    // An edit of the risk in the other set ends nothing here.
    expect(
      openedGatesOf(
        [
          opened('2026-10-13T09:00:00.000Z'),
          changed('2026-10-13T10:00:00.000Z', 'approval', MERGE, OTHER_SET),
        ],
        TODAY,
      ),
    ).toEqual(new Set([MERGE_LINE]));
    // A change that names no set closes the risk in every set: the strict reading.
    expect(
      openedGatesOf(
        [
          opened('2026-10-13T09:00:00.000Z'),
          changed('2026-10-13T10:00:00.000Z', 'approval', MERGE, null),
        ],
        TODAY,
      ),
    ).toEqual(new Set());
  });

  it('feeds decide(): an opened gate lets the call through without consuming an approval', () => {
    const policy = [
      { risk_id: MERGE, quota: 2, rate_limit: { max: 5, window_seconds: 60 }, gate: 'approval' },
    ] as const;
    const input = {
      policy,
      risks_touched: [MERGE],
      counters: new Map<string, number>(),
      rate_windows: new Map(),
      fingerprint: 'f'.repeat(64),
      approvals: new Map([[MERGE, 'apr_1']]),
    };
    const open = openedGatesOf([opened('2026-10-13T09:00:00.000Z')], TODAY);
    expect(decide({ ...input, period: TODAY, opened_gates: openedInSet(open, SET) })).toMatchObject(
      {
        kind: 'allow',
        decrements: [MERGE],
        approvals_to_consume: [],
      },
    );
    // The next period: the same events open nothing, the approval is what lets it through.
    const closed = openedGatesOf([opened('2026-10-13T09:00:00.000Z')], TOMORROW);
    expect(
      decide({ ...input, period: TOMORROW, opened_gates: openedInSet(closed, SET) }),
    ).toMatchObject({
      kind: 'allow',
      approvals_to_consume: [{ risk_id: MERGE, approval_id: 'apr_1' }],
    });
    expect(
      decide({
        ...input,
        approvals: new Map(),
        period: TOMORROW,
        opened_gates: openedInSet(closed, SET),
      }),
    ).toMatchObject({ kind: 'refuse', code: 'approval-required', risk_id: MERGE });
    // An opened gate does not replace the budget either.
    expect(
      decide({
        ...input,
        counters: new Map([[MERGE, 2]]),
        period: TODAY,
        opened_gates: openedInSet(open, SET),
      }),
    ).toMatchObject({ kind: 'refuse', code: 'budget-exhausted' });
  });
});
