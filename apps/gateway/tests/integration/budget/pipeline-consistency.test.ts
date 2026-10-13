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
import { alwaysGrounded } from '../../../src/server/authority/testing.ts';
import { createLogger } from '../../../src/server/logging/index.ts';
import { RequestService } from '../../../src/server/requests/index.ts';
import {
  APPROVAL_VALIDITY_SECONDS,
  at,
  MERGE,
  openBudgetFixture,
  READ,
  WRITE,
  type BudgetFixture,
} from './fixture.ts';

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
        [READ, { risk_id: READ, counted: 6, credited: 0, audited: 6 }],
        [WRITE, { risk_id: WRITE, counted: 1, credited: 0, audited: 1 }],
        [MERGE, { risk_id: MERGE, counted: 0, credited: 0, audited: 0 }],
      ]),
    );
  });

  it('skips a credit event whose details are malformed, and does not throw', async () => {
    const pipeline = buildPipeline(f, () => f.clock.now());
    await pipeline.execute(contextOf(f, f.mission), request([READ]));
    const session = await f.store.sessions.getByMission(f.mission.id);
    if (!session) throw new Error('the first call creates the session');
    const { period } = await countersAgreeWithAudit(f.store, f.mission, f.clock.now());

    // Rows no writer of the gateway produces: a reset without its request and period
    // end, a quota extension whose credit is text, a reset with no details at all.
    await f.store.sessions.recordEvent(session.id, {
      kind: 'reset',
      details: { period_start: period.start, credits: { [READ]: 5 } },
    });
    await f.store.sessions.recordEvent(session.id, {
      kind: 'extension',
      details: {
        request_id: 'r-1',
        dimension: 'quota',
        amount: 2,
        period_start: period.start,
        period_end: period.end,
        credits: { [READ]: '2' },
      },
    });
    await f.store.sessions.recordEvent(session.id, { kind: 'reset' });

    const report = await countersAgreeWithAudit(f.store, f.mission, f.clock.now());
    expect(report.risks.find((r) => r.risk_id === READ)).toEqual({
      risk_id: READ,
      counted: 1,
      credited: 0,
      audited: 1,
    });
    expect(report.mismatches).toEqual([]);
  });

  it('an allowed call that fails upstream keeps its credit: audit says allowed, counter incremented', async () => {
    const pipeline = buildPipeline(f, () => f.clock.now());
    const ctx = contextOf(f, f.mission);
    const outcome = await pipeline.execute(ctx, request([WRITE], { fail: true }));
    expect(outcome.kind).toBe('failed');
    expect(outcome.audit).toMatchObject({
      decision: 'allowed',
      remaining_budget: { [WRITE]: 0 },
    });
    // The wording of the failure is the pipeline's (gateway-core); here it only has to be recorded.
    expect(typeof outcome.audit.upstream_error).toBe('string');
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
      credited: 0,
      audited: 1,
    });
  });

  it('granted claims lower the counters; the check adds back the credits their events record', async () => {
    const requests = new RequestService({
      store: f.store,
      registry: { get: () => undefined },
      grounds: alwaysGrounded,
      publicUrl: new URL('https://gateway.example.com'),
      approvalValiditySeconds: APPROVAL_VALIDITY_SECONDS,
      clock: f.clock,
      logger: createLogger({ level: 'error', redact: (text) => text, write: () => undefined }),
    });
    const creator = { id: f.creatorId };
    const pipeline = buildPipeline(f, () => f.clock.now());
    const ctx = contextOf(f, f.mission);
    const claimOf = async (): Promise<string> => {
      const outcome = await pipeline.execute(ctx, request([WRITE]));
      expect(outcome.audit.refusal_code).toBe('budget-exhausted');
      const [open] = await requests.inbox(creator);
      if (!open) throw new Error('expected an open claim');
      return open.id;
    };
    const check = async () => countersAgreeWithAudit(f.store, f.mission, f.clock.now());

    await pipeline.execute(ctx, request([READ, WRITE])); // READ 1, WRITE 1 (exhausted)
    await pipeline.execute(ctx, request([READ])); // READ 2

    // Quota extension: one action back on WRITE.
    await requests.decide(creator, await claimOf(), { resolution: 'extend-quota', amount: 1 });
    expect((await check()).mismatches).toEqual([]);
    expect((await pipeline.execute(ctx, request([WRITE]))).kind).toBe('allowed');

    // Period reset: every counter back to zero.
    await requests.decide(creator, await claimOf(), { resolution: 'reset-period' });
    expect((await pipeline.execute(ctx, request([READ, WRITE]))).kind).toBe('allowed');

    // A refusal and an expiry extension give nothing back.
    await requests.decide(creator, await claimOf(), { resolution: 'refuse' });

    const report = await check();
    expect(report.mismatches).toEqual([]);
    expect(new Map(report.risks.map((r) => [r.risk_id, r]))).toEqual(
      new Map([
        [READ, { risk_id: READ, counted: 1, credited: 2, audited: 3 }],
        [WRITE, { risk_id: WRITE, counted: 1, credited: 2, audited: 3 }],
        [MERGE, { risk_id: MERGE, counted: 0, credited: 0, audited: 0 }],
      ]),
    );

    // Credits belong to their period: the next one starts clean on both sides.
    f.clock.set('2026-10-14T09:00:00.000Z');
    await pipeline.execute(ctx, request([READ]));
    const next = await check();
    expect(next.mismatches).toEqual([]);
    expect(next.risks.find((r) => r.risk_id === READ)).toEqual({
      risk_id: READ,
      counted: 1,
      credited: 0,
      audited: 1,
    });
  });

  it('a mission with no session yet reports zero everywhere and no mismatch', async () => {
    const report = await countersAgreeWithAudit(f.store, f.mission, at('2026-10-13T09:00:00.000Z'));
    expect(report.mismatches).toEqual([]);
    expect(report.risks.every((r) => r.counted === 0 && r.audited === 0)).toBe(true);
  });
});
