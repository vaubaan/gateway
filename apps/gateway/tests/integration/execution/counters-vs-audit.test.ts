/**
 * Structural test (spec §3.3 "the session is the source of truth for the
 * budget, the audit for what happened; the two must agree", §10 "session
 * counters agree with the audit"): after a randomized sequence of calls sent
 * through the door — allowed, refused on every dimension, failing upstream,
 * in bursts from several agents — the counters and the audit tell the same
 * story for every accepted risk.
 *
 * The sequence is drawn from a seeded generator, so a failure is reproducible:
 * the seed is in the test name.
 */
import type { CallAuditEntry } from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf, countersAgreeWithAudit } from '../../../src/server/budget';
import {
  depotSecret,
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const SEEDS = [20261013, 7, 424242];
const CALLS = 240;

/** mulberry32 — small, deterministic, good enough to shuffle a call sequence. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POLICY = [
  line('depot.read', 60),
  line('depot[staging].write', 25),
  // Rate limited long before the quota.
  line('depot.profile', 500, { rate_limit: { max: 12, window_seconds: 3600 } }),
  line('depot.purge', 5, { gate: 'approval' }),
];

/** What an agent might send: placeable and unplaceable, inside and outside the mission. */
const MOVES: readonly { tool: string; args: Record<string, unknown>; weight: number }[] = [
  { tool: 'depot__read_item', args: { space: 'scratch' }, weight: 8 },
  { tool: 'depot__read_item', args: { space: 'app-staging', item: 'a' }, weight: 6 },
  { tool: 'depot__write_item', args: { space: 'app-staging' }, weight: 6 },
  { tool: 'depot__write_item', args: { space: 'scratch' }, weight: 2 }, // unlabelled: not accepted
  { tool: 'depot__read_item', args: { space: 'app-prod' }, weight: 2 }, // outside the mission
  { tool: 'depot__whoami', args: {}, weight: 5 },
  { tool: 'depot__purge', args: { space: 'scratch' }, weight: 2 }, // approval-required
  { tool: 'depot__read_item', args: { space: 'No Such Ref' }, weight: 1 }, // rejected
  { tool: 'nope__tool', args: {}, weight: 1 }, // unknown tool
];
const TOTAL_WEIGHT = MOVES.reduce((sum, m) => sum + m.weight, 0);

function pick(random: () => number) {
  let at = random() * TOTAL_WEIGHT;
  for (const move of MOVES) {
    at -= move.weight;
    if (at < 0) return move;
  }
  return MOVES[0] as (typeof MOVES)[number];
}

describe('structural: session counters agree with the audit', () => {
  let instance: ExecutionInstance;

  beforeEach(async () => {
    instance = await executionInstance();
  });
  afterEach(async () => {
    await instance.close();
  });

  async function run(seed: number): Promise<IssuedMission> {
    const random = generator(seed);
    const mission = await instance.issue({
      policy: POLICY,
      spaces: ['app-staging', 'scratch'],
    });
    // The provider misbehaves now and then: a failure, or a rejected key that a
    // refresh repairs. Neither changes what was decided.
    instance.depot.scriptRefresh(async () => depotSecret('sk-rotated'));
    instance.depot.script(async (ctx) => {
      const roll = random();
      if (roll < 0.12) throw new Error('depot answered 503');
      const key = ctx.credential.kind === 'api-key' ? ctx.credential.fields.token : '';
      if (roll < 0.18 && key !== 'sk-rotated') throw new UpstreamAuthError('bad key', 401);
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    let sent = 0;
    while (sent < CALLS) {
      // Bursts of 1 to 6 concurrent calls, from three agents sharing the token.
      const burst = Math.min(CALLS - sent, 1 + Math.floor(random() * 6));
      const moves = Array.from({ length: burst }, () => pick(random));
      await Promise.all(
        moves.map((move, i) =>
          instance.call(mission, move.tool, move.args, {
            'x-vaubaan-agent': `agent-${(sent + i) % 3}`,
          }),
        ),
      );
      sent += burst;
    }
    return mission;
  }

  for (const seed of SEEDS) {
    it(`SUM(session_counters) == COUNT(audit allowed) per risk after ${CALLS} random calls (seed ${seed})`, async () => {
      const mission = await run(seed);
      const { store } = instance.root;
      const record = await store.missions.getById(mission.mission.id);
      if (!record) throw new Error('mission vanished');

      const report = await countersAgreeWithAudit(
        { sessions: store.sessions, audit: store.audit },
        budgetMissionOf(record),
        new Date(),
      );
      expect(report.mismatches).toEqual([]);
      expect(report.risks.map((r) => r.risk_id).sort()).toEqual(
        POLICY.map((p) => p.risk_id).sort(),
      );

      // Every call left exactly one entry, whatever happened to it.
      const entries = (await store.audit.list({
        missionId: mission.mission.id,
        kind: 'call',
        limit: CALLS * 2,
      })) as unknown as CallAuditEntry[];
      expect(entries).toHaveLength(CALLS);

      // The sequence really exercised the pipeline: allowed calls, failed forwards
      // and every refusal the policy can produce.
      const allowed = entries.filter((e) => e.decision === 'allowed');
      expect(allowed.length).toBeGreaterThan(40);
      expect(allowed.some((e) => e.upstream_error !== null)).toBe(true);
      const codes = new Set(entries.map((e) => e.refusal_code));
      for (const code of [
        'risk-not-accepted',
        'resource-not-in-mission',
        'rate-limited',
        'approval-required',
        null,
      ]) {
        expect(codes.has(code as never)).toBe(true);
      }

      // No quota was overrun, and the counted total is the audited total.
      const byRisk = new Map(report.risks.map((r) => [r.risk_id, r]));
      for (const entry of POLICY) {
        expect(byRisk.get(entry.risk_id)?.counted).toBeLessThanOrEqual(entry.quota);
      }
      expect(byRisk.get('depot.profile')?.counted).toBe(12);
      expect(byRisk.get('depot.purge')?.counted).toBe(0);
      const counted = report.risks.reduce((sum, r) => sum + r.counted, 0);
      expect(counted).toBe(allowed.length);

      // The last allowed entry of a risk carries the remainder the counters imply.
      for (const entry of POLICY) {
        const last = [...allowed].reverse().find((e) => e.risks_touched.includes(entry.risk_id));
        if (!last) continue;
        const remaining = Math.min(
          ...allowed
            .filter((e) => e.risks_touched.includes(entry.risk_id))
            .map((e) => e.remaining_budget?.[entry.risk_id] ?? Number.NaN),
        );
        expect(remaining).toBe(entry.quota - (byRisk.get(entry.risk_id)?.counted ?? 0));
      }
    });
  }

  it('reaches budget-exhausted under the same random load when the quota is small', async () => {
    const mission = await instance.issue({ policy: [line('depot.read', 7)] });
    await Promise.all(
      Array.from({ length: 30 }, () =>
        instance.call(mission, 'depot__read_item', { space: 'scratch' }),
      ),
    );
    const { store } = instance.root;
    const record = await store.missions.getById(mission.mission.id);
    if (!record) throw new Error('mission vanished');
    const report = await countersAgreeWithAudit(
      { sessions: store.sessions, audit: store.audit },
      budgetMissionOf(record),
      new Date(),
    );
    expect(report.mismatches).toEqual([]);
    expect(report.risks).toEqual([{ risk_id: 'depot.read', counted: 7, credited: 0, audited: 7 }]);
    const entries = (await store.audit.list({
      missionId: mission.mission.id,
      limit: 100,
    })) as unknown as CallAuditEntry[];
    expect(entries.filter((e) => e.refusal_code === 'budget-exhausted')).toHaveLength(23);
    expect(instance.depot.calls).toHaveLength(7);
  });
});
