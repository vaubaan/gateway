/**
 * The limits a decision is taken with (ADR mission-editable-after-issuance): the
 * caller's policy, with the quota and the rate of each risk as the store holds them in
 * the decision's own transaction. Which risks are accepted, and their gates, are the
 * caller's: a change of limits moves neither.
 */
import type { MissionPolicy } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { livePolicy } from '../../../../src/server/budget/index.ts';

const READ = 'github.read-code';
const MERGE = 'github.merge-protected';

const LOADED: MissionPolicy = [
  { risk_id: READ, quota: 5, rate_limit: { max: 50, window_seconds: 60 }, gate: 'auto' },
  { risk_id: MERGE, quota: 2, rate_limit: { max: 10, window_seconds: 60 }, gate: 'approval' },
];

describe('livePolicy', () => {
  it('takes the stored quota and rate of each risk the store returned', () => {
    const live = livePolicy(
      LOADED,
      new Map([[READ, { quota: 1, rateLimit: 3, rateWindowSeconds: 60 }]]),
    );
    expect(live).toEqual([
      { risk_id: READ, quota: 1, rate_limit: { max: 3, window_seconds: 60 }, gate: 'auto' },
      LOADED[1],
    ]);
  });

  it('keeps the gate and the list of risks the caller loaded', () => {
    const live = livePolicy(
      LOADED,
      new Map([
        [MERGE, { quota: 9, rateLimit: 9, rateWindowSeconds: 60 }],
        ['github.bulk-file-write', { quota: 99, rateLimit: 99, rateWindowSeconds: 60 }],
      ]),
    );
    expect(live.map((entry) => entry.risk_id)).toEqual([READ, MERGE]);
    expect(live[1]).toMatchObject({ gate: 'approval', quota: 9 });
  });

  it('with nothing stored (no row read), is the loaded policy itself', () => {
    expect(livePolicy(LOADED, new Map())).toEqual(LOADED);
  });
});
