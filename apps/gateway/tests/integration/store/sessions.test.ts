/**
 * Sessions and the transactional decision primitive. Spec §3.3, §6 "authoritative,
 * atomic counting", §10 "atomicity on the last credit, several agents concurrent on the
 * same token". The accounting rules themselves are P1.3; here the `decide` callbacks are
 * minimal stand-ins that compare counters to a quota.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecideContext, Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';
const MERGE = 'github.merge-protected';
const PERIOD = '2026-10-13T00:00:00.000Z';

describe('sessions repository', () => {
  let t: TestStore;
  let store: Store;
  let missionId: string;
  let creator: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (await store.users.upsertFromIdp({ subject: 'c', email: 'c@x' })).id;
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: creator },
      displayName: 'gh',
      credential: null,
    });
    const mission = await store.missions.create({
      name: 'm',
      creatorUserId: creator,
      periodAnchor: PERIOD,
      periodSeconds: 86_400,
      connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
      policy: [
        { riskId: READ, quota: 10, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
        { riskId: WRITE, quota: 1, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
        { riskId: MERGE, quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' },
      ],
    });
    missionId = mission.id;
  });
  afterEach(() => store.close());

  const quotaDecider =
    (quotas: Record<string, number>) =>
    (ctx: DecideContext): { allow: boolean; event: { kind: string } } => {
      const allow = [...ctx.counters].every(([risk, consumed]) => consumed < (quotas[risk] ?? 0));
      return { allow, event: { kind: allow ? 'allowed-call' : 'refused-call' } };
    };

  it('the session is born on the first call and never recreated', async () => {
    expect(await store.sessions.getByMission(missionId)).toBeNull();
    const result = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [READ], periodStart: PERIOD },
      quotaDecider({ [READ]: 10 }),
    );
    expect(result.session.missionId).toBe(missionId);
    expect(result.session.createdAt).toBe(t.clock.now().toISOString());
    const again = await store.sessions.getOrCreate(missionId);
    expect(again).toEqual(result.session);
    expect(await store.sessions.getById(again.id)).toEqual(again);
  });

  it('N concurrent decisions on a quota of 1 produce exactly one allow', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.sessions.decideAndDecrement(
          { missionId, riskIds: [WRITE], periodStart: PERIOD },
          quotaDecider({ [WRITE]: 1 }),
        ),
      ),
    );
    const allows = results.filter((r) => r.outcome.allow);
    expect(allows).toHaveLength(1);
    expect(results.filter((r) => !r.outcome.allow)).toHaveLength(N - 1);
    const session = allows[0]?.session;
    if (!session) throw new Error('expected a session');
    expect(await store.sessions.counters(session.id, PERIOD)).toEqual([
      { sessionId: session.id, riskId: WRITE, periodStart: PERIOD, consumed: 1 },
    ]);
    const events = await store.sessions.listEvents(session.id);
    expect(events.filter((e) => e.kind === 'allowed-call')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'refused-call')).toHaveLength(N - 1);
  });

  it('a call touching N risks decrements N counters; a refusal decrements none', async () => {
    const allowed = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [READ, WRITE, WRITE], periodStart: PERIOD },
      quotaDecider({ [READ]: 10, [WRITE]: 1 }),
    );
    expect(allowed.outcome.allow).toBe(true);
    expect([...allowed.counters]).toEqual([
      [READ, 1],
      [WRITE, 1],
    ]);

    const refused = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [READ, WRITE], periodStart: PERIOD },
      quotaDecider({ [READ]: 10, [WRITE]: 1 }),
    );
    expect(refused.outcome.allow).toBe(false);
    expect([...refused.counters]).toEqual([
      [READ, 1],
      [WRITE, 1],
    ]);
  });

  it('period rollover is a matter of key: a new period starts at zero', async () => {
    await store.sessions.decideAndDecrement(
      { missionId, riskIds: [WRITE], periodStart: PERIOD },
      quotaDecider({ [WRITE]: 1 }),
    );
    const nextPeriod = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [WRITE], periodStart: '2026-10-14T00:00:00.000Z' },
      quotaDecider({ [WRITE]: 1 }),
    );
    expect(nextPeriod.outcome.allow).toBe(true);
    const session = nextPeriod.session;
    expect(
      (await store.sessions.counters(session.id)).map((c) => [c.periodStart, c.consumed]),
    ).toEqual([
      [PERIOD, 1],
      ['2026-10-14T00:00:00.000Z', 1],
    ]);
  });

  it('a thrown decider rolls everything back, including the session creation', async () => {
    await expect(
      store.sessions.decideAndDecrement({ missionId, riskIds: [READ], periodStart: PERIOD }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.sessions.getByMission(missionId)).toBeNull();
  });

  it('consumes an approval inside the decision transaction, single use', async () => {
    const session = await store.sessions.getOrCreate(missionId);
    const request = await store.requests.create({
      missionId,
      sessionId: session.id,
      kind: 'approval',
      riskId: MERGE,
      tool: 'github__merge_pull_request',
      fingerprint: 'fp-1',
      arguments: { pr: 42 },
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    await store.requests.decide(request.id, 'granted', creator);
    const approval = await store.approvals.create({
      missionId,
      requestId: request.id,
      riskId: MERGE,
      fingerprint: 'fp-1',
      expiresAt: '2026-10-13T09:30:00.000Z',
    });

    const decide = (ctx: DecideContext) => {
      const consumed = ctx.consumeApproval(MERGE, 'fp-1');
      return { allow: consumed !== null, approvalId: consumed?.id ?? null, event: null };
    };
    const first = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [MERGE], periodStart: PERIOD },
      decide,
    );
    expect(first.outcome).toMatchObject({ allow: true, approvalId: approval.id });
    const replay = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [MERGE], periodStart: PERIOD },
      decide,
    );
    expect(replay.outcome.allow).toBe(false);
    expect(replay.counters.get(MERGE)).toBe(1);
    expect((await store.approvals.getById(approval.id))?.consumedAt).toBe(
      t.clock.now().toISOString(),
    );
  });

  it('drops a request and records extra events from inside the refusal transaction', async () => {
    const result = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [WRITE], periodStart: PERIOD },
      (ctx) => {
        const request = ctx.createRequest({
          kind: 'claim',
          riskId: WRITE,
          expiresAt: '2026-10-14T09:00:00.000Z',
        });
        ctx.recordEvent({ kind: 'request', riskId: WRITE, details: { requestId: request.id } });
        return {
          allow: false,
          requestId: request.id,
          event: { kind: 'refused-call', riskId: WRITE },
        };
      },
    );
    const request = await store.requests.getById(result.outcome.requestId);
    expect(request).toMatchObject({
      missionId,
      sessionId: result.session.id,
      kind: 'claim',
      state: 'open',
      riskId: WRITE,
    });
    expect((await store.requests.listOpenForCreator(creator)).map((r) => r.id)).toEqual([
      result.outcome.requestId,
    ]);
    const events = await store.sessions.listEvents(result.session.id);
    expect(events.map((e) => e.kind)).toEqual(['request', 'refused-call']);
    expect(events[0]?.details).toEqual({ requestId: result.outcome.requestId });
  });

  it('resets counters for a period (granted claim) and lists events since a timestamp', async () => {
    const r = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [READ, WRITE], periodStart: PERIOD },
      quotaDecider({ [READ]: 10, [WRITE]: 1 }),
    );
    expect(await store.sessions.resetCounters(r.session.id, PERIOD, WRITE)).toBe(1);
    expect(
      (await store.sessions.counters(r.session.id, PERIOD)).map((c) => [c.riskId, c.consumed]),
    ).toEqual([
      [READ, 1],
      [WRITE, 0],
    ]);
    expect(await store.sessions.resetCounters(r.session.id, PERIOD)).toBe(2);

    t.clock.advance(5000);
    const later = await store.sessions.recordEvent(r.session.id, {
      kind: 'reset',
      actorUserId: creator,
      details: { by: 'claim' },
    });
    expect(later.actorUserId).toBe(creator);
    expect(await store.sessions.listEvents(r.session.id, { since: later.ts })).toEqual([later]);
    expect(await store.sessions.listEvents(r.session.id, { limit: 1 })).toHaveLength(1);
  });

  it('counters and audit agree after a mixed run (structural check)', async () => {
    const decider = quotaDecider({ [READ]: 3 });
    for (let i = 0; i < 5; i++) {
      const r = await store.sessions.decideAndDecrement(
        { missionId, riskIds: [READ], periodStart: PERIOD },
        decider,
      );
      await store.audit.append({
        kind: 'call',
        ts: t.clock.now().toISOString(),
        mission_id: missionId,
        session_id: r.session.id,
        connection_id: null,
        resource_ref: null,
        tool: 'github__get_file',
        arguments_hash: `h${i}`,
        slices_executed: [],
        risks_touched: [READ],
        accepted_risks_snapshot: [READ, WRITE, MERGE],
        decision: r.outcome.allow ? 'allowed' : 'refused',
        refusal_code: r.outcome.allow ? null : 'budget-exhausted',
        refusal_reason: null,
        approval_id: null,
        remaining_budget: { [READ]: 3 - (r.counters.get(READ) ?? 0) },
        agent_label: null,
        upstream_latency_ms: null,
        upstream_error: null,
        client_ip: null,
        client_user_agent: null,
      });
      t.clock.advance(1000);
    }
    const session = await store.sessions.getOrCreate(missionId);
    const consumed = (await store.sessions.counters(session.id, PERIOD)).find(
      (c) => c.riskId === READ,
    );
    const audited = await store.audit.countAllowedTouches(
      missionId,
      READ,
      PERIOD,
      '2026-10-14T00:00:00.000Z',
    );
    expect(consumed?.consumed).toBe(3);
    expect(audited).toBe(3);
  });
});
