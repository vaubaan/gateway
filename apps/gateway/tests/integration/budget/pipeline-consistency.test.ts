/**
 * The budget stage inside gateway-core's `CallPipeline`, with the store's audit writer:
 * the structural check "session counters agree with the audit" (spec §3.3, §10) and the
 * decision on upstream failure (credit consumed, not refunded; ADR
 * atomic-budget-accounting).
 */
import {
  CallPipeline,
  type CallRequest,
  type MissionContext,
  type ResourceStage,
  type RiskStage,
  type UpstreamStage,
} from '@vaubaan/gateway-core';
import type { RiskId } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countersAgreeWithAudit,
  createBudgetStage,
  type BudgetMission,
} from '../../../src/server/budget/index.ts';
import { at, MERGE, openBudgetFixture, READ, WRITE, type BudgetFixture } from './fixture.ts';

/** Stages that let the test drive the risks touched and the upstream outcome through
 *  the call arguments: `args.risks` and `args.fail`. */
function contextOf(f: BudgetFixture, mission: BudgetMission): MissionContext {
  return {
    mission: {
      id: mission.id,
      name: 'm',
      status: mission.status,
      creator_id: f.creatorId,
      expires_at: mission.expires_at,
      period:
        mission.period.length_seconds === null
          ? { kind: 'one-off' }
          : {
              kind: 'recurring',
              length_seconds: mission.period.length_seconds,
              anchor_at: mission.period.anchor_at,
            },
    },
    token: { id: 'tok_1', prefix: 'abcdefgh' },
    connections: [
      {
        id: f.connectionId,
        provider: 'github',
        display_name: 'gh',
        status: 'active',
        owner: { kind: 'user', id: f.creatorId, display: 'c@x' },
      },
    ],
    resources: [],
    policy: mission.policy,
    session: null,
  };
}

function buildPipeline(f: BudgetFixture, now: () => Date): CallPipeline {
  const resources: ResourceStage = {
    async resolve(ctx) {
      const connection = ctx.connections[0];
      if (!connection) throw new Error('fixture has a connection');
      return { ok: true, target: { connection, resource: null } };
    },
  };
  const risks: RiskStage = {
    async evaluate(_ctx, call) {
      return {
        kind: 'allow',
        risks_touched: call.args.risks as RiskId[],
        executed_slices: [],
      };
    },
  };
  const upstream: UpstreamStage = {
    async execute(_ctx, call) {
      if (call.args.fail) throw new Error('provider 502');
      return { ok: true };
    },
  };
  return new CallPipeline({
    resources,
    risks,
    upstream,
    budget: createBudgetStage({ service: f.service, missions: f.store.missions }),
    audit: f.store.auditWriter,
    now,
  });
}

const request = (risks: readonly string[], extra: Record<string, unknown> = {}): CallRequest => ({
  tool: 'github__tool',
  args: { risks, ...extra },
  agent_label: null,
  client: { ip: null, user_agent: null },
});

describe('budget stage in the pipeline — counters vs audit', () => {
  let f: BudgetFixture;

  beforeEach(async () => {
    f = await openBudgetFixture();
  });
  afterEach(() => f.store.close());

  it('after a mixed run, SUM(session_counters) == COUNT(audit allowed) per risk', async () => {
    const pipeline = buildPipeline(f, () => f.clock.now());
    const ctx = contextOf(f, f.mission);
    const outcomes: string[] = [];
    const run = async (call: CallRequest) => {
      outcomes.push((await pipeline.execute(ctx, call)).kind);
      f.clock.advance(100);
    };

    await run(request([READ, WRITE])); // allowed
    await run(request([READ], { fail: true })); // allowed, then upstream failed
    await run(request([WRITE])); // budget-exhausted
    await run(request([MERGE])); // approval-required
    await Promise.all(Array.from({ length: 8 }, () => pipeline.execute(ctx, request([READ])))); // 3 allowed, 5 rate-limited (window of 5)
    f.clock.advance(61_000);
    await run(request([READ, WRITE])); // budget-exhausted on WRITE: READ untouched
    await run(request([READ])); // allowed

    expect(outcomes).toEqual(['allowed', 'failed', 'refused', 'refused', 'refused', 'allowed']);

    const report = await countersAgreeWithAudit(f.store, f.mission, f.clock.now());
    expect(report.mismatches).toEqual([]);
    expect(new Map(report.risks.map((r) => [r.risk_id, r]))).toEqual(
      new Map([
        [READ, { risk_id: READ, counted: 6, audited: 6 }],
        [WRITE, { risk_id: WRITE, counted: 1, audited: 1 }],
        [MERGE, { risk_id: MERGE, counted: 0, audited: 0 }],
      ]),
    );
  });

  it('an allowed call that fails upstream keeps its credit: audit says allowed, counter incremented', async () => {
    const pipeline = buildPipeline(f, () => f.clock.now());
    const ctx = contextOf(f, f.mission);
    const outcome = await pipeline.execute(ctx, request([WRITE], { fail: true }));
    expect(outcome.kind).toBe('failed');
    expect(outcome.audit).toMatchObject({
      decision: 'allowed',
      upstream_error: 'provider 502',
      remaining_budget: { [WRITE]: 0 },
    });
    // Not refunded: the next WRITE is refused.
    const next = await pipeline.execute(ctx, request([WRITE]));
    expect(next.kind).toBe('refused');
    expect(next.audit.refusal_code).toBe('budget-exhausted');
    expect((await countersAgreeWithAudit(f.store, f.mission, f.clock.now())).mismatches).toEqual(
      [],
    );
  });

  it('a one-off mission: the stage reads the stored anchor and the check spans the open period', async () => {
    const oneOff = await f.createMission({ periodSeconds: null });
    const pipeline = buildPipeline(f, () => f.clock.now());
    const ctx = contextOf(f, oneOff);
    expect((await pipeline.execute(ctx, request([WRITE]))).kind).toBe('allowed');
    f.clock.set('2028-01-01T00:00:00.000Z');
    expect((await pipeline.execute(ctx, request([WRITE]))).kind).toBe('refused');
    const report = await countersAgreeWithAudit(f.store, oneOff, f.clock.now());
    expect(report.period.end).toBeNull();
    expect(report.mismatches).toEqual([]);
    expect(report.risks.find((r) => r.risk_id === WRITE)).toEqual({
      risk_id: WRITE,
      counted: 1,
      audited: 1,
    });
  });

  it('a mission with no session yet reports zero everywhere and no mismatch', async () => {
    const report = await countersAgreeWithAudit(f.store, f.mission, at('2026-10-13T09:00:00.000Z'));
    expect(report.mismatches).toEqual([]);
    expect(report.risks.every((r) => r.counted === 0 && r.audited === 0)).toBe(true);
  });
});
