/**
 * The pure count behind trust-raise proposals (risk model §4.7): per macro-action of
 * one resource set, approvals granted since the latest of issuance, level change,
 * "Not now" and the last refusal; claims never count; Autonomous is never offered.
 */
import type { MacroAction } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { nextTrustLevel, trustRaiseOffers } from '../../../../src/server/missions/trust-raise.ts';
import type {
  MissionRecord,
  MissionTrustMarkRecord,
  RequestRecord,
} from '../../../../src/server/store/types.ts';

const BUDGET = { quota: 10, rate_limit: { max: 5, window_seconds: 60 } };
const ACTIONS: MacroAction[] = [
  { id: 'read', label: 'Read', description: '', entries: [{ risk_id: 'acme.read', ...BUDGET }] },
  {
    id: 'change',
    label: 'Change',
    description: '',
    entries: [{ risk_id: 'acme.write', ...BUDGET }],
  },
];
const MISSION: Pick<MissionRecord, 'createdAt' | 'connections'> = {
  createdAt: '2026-11-01T00:00:00.000Z',
  connections: [
    {
      connectionId: 'conn',
      resourceSets: [
        {
          id: 's1',
          position: 1,
          resourceScope: 'selected' as const,
          resourceIds: ['r1'],
          trustLevels: { change: 'careful', read: 'autonomous' },
        },
        {
          id: 's2',
          position: 2,
          resourceScope: 'selected' as const,
          resourceIds: ['r2'],
          trustLevels: { change: 'trusting' },
        },
      ],
    },
  ],
};

type Req = Pick<RequestRecord, 'kind' | 'state' | 'lines' | 'decidedAt'>;
const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
function approval(set: string, risk: string, minute: number, state: Req['state'] = 'granted'): Req {
  return {
    kind: 'approval',
    state,
    lines: [{ resourceSetId: set, riskId: risk }],
    decidedAt: at(minute),
  };
}

function offers(requests: readonly Req[], marks: readonly MissionTrustMarkRecord[] = []) {
  return trustRaiseOffers({
    mission: MISSION,
    accountOf: () => ({ name: 'Acme', macroActions: ACTIONS }),
    requests,
    marks,
    threshold: 2,
  });
}

describe('trustRaiseOffers', () => {
  it('counts per set: set 2’s approvals raise set 2 only, from its own level', () => {
    const found = offers([
      approval('s2', 'acme[staging].write', 1),
      approval('s2', 'acme.write', 2),
    ]);
    expect(found).toEqual([
      expect.objectContaining({
        resource_set_id: 's2',
        resource_set_position: 2,
        several_sets: true,
        macro_action_id: 'change',
        from: 'trusting',
        to: 'autonomous',
        approvals: 2,
      }),
    ]);
  });

  it('never offers Autonomous, and counts no claim', () => {
    const claims: Req[] = [1, 2, 3].map((m) => ({
      ...approval('s1', 'acme.write', m),
      kind: 'claim',
    }));
    expect(
      offers([approval('s1', 'acme.read', 1), approval('s1', 'acme.read', 2), ...claims]),
    ).toEqual([]);
  });

  it('starts again after a refusal, a level change or a "Not now"', () => {
    const run = [approval('s1', 'acme.write', 1), approval('s1', 'acme.write', 2)];
    expect(offers(run)).toHaveLength(1);
    expect(offers([...run, approval('s1', 'acme.write', 3, 'refused')])).toEqual([]);
    const mark = (field: 'levelChangedAt' | 'snoozedAt'): MissionTrustMarkRecord => ({
      resourceSetId: 's1',
      macroActionId: 'change',
      levelChangedAt: null,
      snoozedAt: null,
      [field]: at(2),
    });
    expect(offers(run, [mark('levelChangedAt')])).toEqual([]);
    expect(offers(run, [mark('snoozedAt')])).toEqual([]);
    expect(
      offers(
        [...run, approval('s1', 'acme.write', 3), approval('s1', 'acme.write', 4)],
        [mark('snoozedAt')],
      ),
    ).toHaveLength(1);
  });

  it('skips an account whose plugin is gone', () => {
    const found = trustRaiseOffers({
      mission: MISSION,
      accountOf: () => null,
      requests: [approval('s2', 'acme.write', 1), approval('s2', 'acme.write', 2)],
      marks: [],
      threshold: 2,
    });
    expect(found).toEqual([]);
  });
});

describe('nextTrustLevel', () => {
  it('goes one level up and stops at Autonomous', () => {
    expect(nextTrustLevel('careful')).toBe('trusting');
    expect(nextTrustLevel('trusting')).toBe('autonomous');
    expect(nextTrustLevel('autonomous')).toBeNull();
  });
});
