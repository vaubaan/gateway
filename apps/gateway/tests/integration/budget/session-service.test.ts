/**
 * SessionService over the embedded store (spec §3.2, §3.3, §3.5, §6 "authoritative,
 * atomic counting"; §10 "multi-risk decrement, period rollover on read, atomicity on
 * the last credit, several agents concurrent on the same token", "approval: binding to
 * the exact fingerprint, single use, whole refusal of a multi-risk call").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetInvariantError,
  fingerprintArguments,
  missionUsageReader,
  SessionService,
  type RecordCallAllowed,
  type RecordCallRefused,
  type RecordCallResult,
} from '../../../src/server/budget/index.ts';
import { grantApprovalRequest, heldArguments, refuseRequest } from '../../support/store/testing.ts';
import {
  ANCHOR,
  APPROVAL_VALIDITY_SECONDS,
  at,
  byRisk,
  DAY_SECONDS,
  MERGE,
  openBudgetFixture,
  READ,
  REQUEST_EXPIRY_SECONDS,
  WRITE,
  type BudgetFixture,
} from './fixture.ts';

const NOW = at('2026-10-13T09:00:00.000Z');
const DAY1 = '2026-10-14T00:00:00.000Z';

function allowed(result: RecordCallResult): RecordCallAllowed {
  if (result.outcome !== 'allowed') throw new Error(`expected allow, got ${result.refusal.code}`);
  return result;
}

function refused(result: RecordCallResult): RecordCallRefused {
  if (result.outcome !== 'refused') throw new Error('expected a refusal');
  return result;
}

describe('SessionService.recordCall', () => {
  let f: BudgetFixture;

  beforeEach(async () => {
    f = await openBudgetFixture();
  });
  afterEach(() => f.store.close());

  const call = (
    risks: readonly string[],
    overrides: { now?: Date; args?: unknown; agent_label?: string | null; tool?: string } = {},
  ) =>
    f.service.recordCall({
      mission: f.mission,
      tool: overrides.tool ?? 'github__get_file',
      args: overrides.args ?? { repo: 'acme/app' },
      risks_touched: risks,
      agent_label: overrides.agent_label ?? null,
      now: overrides.now ?? NOW,
    });

  const countersOf = async (sessionId: string, periodStart = ANCHOR) =>
    Object.fromEntries(
      (await f.store.sessions.counters(sessionId, periodStart)).map((c) => [c.riskId, c.consumed]),
    );

  it('the session is born on the first call; N risks decrement N counters', async () => {
    expect(await f.store.sessions.getByMission(f.mission.id)).toBeNull();
    const result = allowed(await call([READ, WRITE, READ]));
    expect(result).toMatchObject({
      period: { index: 0, start: ANCHOR, end: DAY1 },
      decrements: [READ, WRITE],
      remaining: { [READ]: 9, [WRITE]: 0 },
      approval_ids: [],
      fingerprint: fingerprintArguments({ repo: 'acme/app' }),
    });
    expect(await countersOf(result.session_id)).toEqual({ [READ]: 1, [WRITE]: 1 });
    const events = await f.store.sessions.listEvents(result.session_id);
    expect(events.map((e) => e.kind)).toEqual(['call-allowed']);
    expect(events[0]?.details).toMatchObject({
      tool: 'github__get_file',
      risk_ids: [READ, WRITE],
      remaining: { [READ]: 9, [WRITE]: 0 },
    });
  });

  it('a refused call decrements nothing and drops one claim in the creator inbox', async () => {
    allowed(await call([WRITE]));
    const result = refused(await call([WRITE]));
    expect(result.refusal).toMatchObject({
      code: 'budget-exhausted',
      risk_id: WRITE,
      quota: 1,
      consumed: 1,
      period_end: DAY1,
    });
    expect(result.request_id).not.toBeNull();
    if (result.refusal.code !== 'budget-exhausted') throw new Error('unreachable');
    expect(result.refusal.claim_url).toBe(f.requestUrl(result.request_id as string));
    expect(await countersOf(result.session_id)).toEqual({ [WRITE]: 1 });

    const inbox = await f.store.requests.listOpenForCreator(f.creatorId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: result.request_id,
      kind: 'claim',
      riskId: WRITE,
      state: 'open',
      sessionId: result.session_id,
      expiresAt: new Date(NOW.getTime() + REQUEST_EXPIRY_SECONDS * 1000).toISOString(),
    });
    const kinds = (await f.store.sessions.listEvents(result.session_id)).map((e) => e.kind);
    expect(kinds).toEqual(['call-allowed', 'request', 'call-refused']);
  });

  it('a replayed refusal reuses the open request instead of flooding the inbox', async () => {
    allowed(await call([WRITE]));
    const first = refused(await call([WRITE]));
    const second = refused(await call([WRITE], { now: at('2026-10-13T09:05:00.000Z') }));
    expect(second.request_id).toBe(first.request_id);
    expect(await f.store.requests.listOpenForCreator(f.creatorId)).toHaveLength(1);
    // Once the creator decided, a new refusal opens a new claim.
    await refuseRequest(f.store, first.request_id as string, f.creatorId);
    const third = refused(await call([WRITE], { now: at('2026-10-13T09:10:00.000Z') }));
    expect(third.request_id).not.toBe(first.request_id);
  });

  it('whole-call refusal: one exhausted risk refuses a call touching others too', async () => {
    allowed(await call([WRITE]));
    const result = refused(await call([READ, WRITE]));
    expect(result.refusal).toMatchObject({ code: 'budget-exhausted', risk_id: WRITE });
    expect(await countersOf(result.session_id)).toEqual({ [WRITE]: 1 });
  });

  it('rollover on read: the next period starts at zero, nothing ran in between', async () => {
    allowed(await call([WRITE]));
    refused(await call([WRITE]));
    const next = allowed(await call([WRITE], { now: at('2026-10-14T00:00:00.000Z') }));
    expect(next.period).toEqual({ index: 1, start: DAY1, end: '2026-10-15T00:00:00.000Z' });
    expect(await countersOf(next.session_id, ANCHOR)).toEqual({ [WRITE]: 1 });
    expect(await countersOf(next.session_id, DAY1)).toEqual({ [WRITE]: 1 });
  });

  it('reload for recurring missions is arithmetic; a one-off mission never reloads', async () => {
    const hourly = await f.createMission({ periodSeconds: 3600 });
    const oneOff = await f.createMission({ periodSeconds: null });
    const on = (mission: typeof hourly, now: Date) =>
      f.service.recordCall({ mission, tool: 't', args: {}, risks_touched: [WRITE], now });

    allowed(await on(hourly, at('2026-10-13T00:10:00.000Z')));
    refused(await on(hourly, at('2026-10-13T00:59:59.000Z')));
    allowed(await on(hourly, at('2026-10-13T01:00:00.000Z')));
    allowed(await on(hourly, at('2026-10-13T07:30:00.000Z')));

    allowed(await on(oneOff, at('2026-10-13T00:10:00.000Z')));
    const later = refused(await on(oneOff, at('2027-10-13T00:10:00.000Z')));
    expect(later.refusal).toMatchObject({ code: 'budget-exhausted', period_end: null });
  });

  it('N concurrent calls on the last credit: exactly one allow, one claim, counter at 1', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => call([WRITE], { agent_label: `agent-${i % 5}` })),
    );
    const allows = results.filter((r) => r.outcome === 'allowed');
    const refusals = results.filter((r) => r.outcome === 'refused');
    expect(allows).toHaveLength(1);
    expect(refusals).toHaveLength(N - 1);
    expect(refusals.every((r) => r.refusal.code === 'budget-exhausted')).toBe(true);
    const sessionId = (allows[0] as RecordCallAllowed).session_id;
    expect(await countersOf(sessionId)).toEqual({ [WRITE]: 1 });
    expect(await f.store.requests.listOpenForCreator(f.creatorId)).toHaveLength(1);
    expect(new Set(refusals.map((r) => r.request_id)).size).toBe(1);
  });

  it('several agent labels on one token share the counters; labels only reach the events', async () => {
    const a = allowed(await call([READ], { agent_label: 'orchestrator' }));
    allowed(await call([READ], { agent_label: 'worker-1' }));
    allowed(await call([READ], { agent_label: 'worker-2' }));
    expect(await countersOf(a.session_id)).toEqual({ [READ]: 3 });
    const labels = (await f.store.sessions.listEvents(a.session_id)).map(
      (e) => e.details?.agent_label,
    );
    expect(labels).toEqual(['orchestrator', 'worker-1', 'worker-2']);
    // The shared counter is what refuses, whoever asks.
    allowed(await call([WRITE], { agent_label: 'worker-1' }));
    expect(refused(await call([WRITE], { agent_label: 'worker-2' })).refusal.code).toBe(
      'budget-exhausted',
    );
  });

  it('rate-limited: no request, no decrement, retry after the oldest action leaves the window', async () => {
    for (let i = 0; i < 5; i++) {
      allowed(await call([READ], { now: at(`2026-10-13T09:00:0${i}.000Z`) }));
    }
    const limited = refused(await call([READ], { now: at('2026-10-13T09:00:30.000Z') }));
    expect(limited.refusal).toEqual(
      expect.objectContaining({
        code: 'rate-limited',
        risk_id: READ,
        limit: { max: 5, window_seconds: 60 },
        retry_after_seconds: 30,
      }),
    );
    expect(limited.request_id).toBeNull();
    expect(await countersOf(limited.session_id)).toEqual({ [READ]: 5 });
    expect(await f.store.requests.listOpenForCreator(f.creatorId)).toHaveLength(0);
    allowed(await call([READ], { now: at('2026-10-13T09:01:00.000Z') }));
    expect(await countersOf(limited.session_id)).toEqual({ [READ]: 6 });
  });

  it('a refusal on another risk records nothing in the rate window either', async () => {
    allowed(await call([WRITE]));
    for (let i = 0; i < 10; i++) refused(await call([READ, WRITE]));
    // READ's window never saw those refusals: five READs still pass.
    for (let i = 0; i < 5; i++) allowed(await call([READ]));
    refused(await call([READ]));
  });

  describe('approval gate', () => {
    const args = { pr: 42, repo: 'acme/app' };
    const tool = 'github__merge_pull_request';

    // The approval is bound to the request's own risk, tool and fingerprint: a grant
    // cannot name another call.
    const grant = (requestId: string, expiresAt: string) =>
      grantApprovalRequest(f.store, requestId, f.creatorId, expiresAt);

    it('refuses with an approval request holding the sealed arguments and the fingerprint', async () => {
      const result = refused(await call([MERGE], { args, tool }));
      expect(result.refusal).toMatchObject({
        code: 'approval-required',
        risk_id: MERGE,
        fingerprint: fingerprintArguments(args),
        approval_url: f.requestUrl(result.request_id as string),
        approval_valid_seconds: APPROVAL_VALIDITY_SECONDS,
      });
      const request = await f.store.requests.getById(result.request_id as string);
      expect(request).toMatchObject({
        kind: 'approval',
        tool,
        fingerprint: fingerprintArguments(args),
        hasArguments: true,
      });
      expect(await heldArguments(f.store, request?.id as string)).toEqual(args);
      if (result.refusal.code !== 'approval-required') throw new Error('unreachable');
      expect(result.refusal.expires_at).toBe(request?.expiresAt);
      expect(await countersOf(result.session_id)).toEqual({});
    });

    it('a granted approval is consumed by the identical replay (any key order), once', async () => {
      const first = refused(await call([MERGE], { args, tool }));
      const approval = await grant(first.request_id as string, '2026-10-13T09:30:00.000Z');
      const replay = allowed(
        await call([MERGE, READ], { args: { repo: 'acme/app', pr: 42 }, tool }),
      );
      expect(replay.approval_ids).toEqual([approval.id]);
      expect(replay.remaining).toEqual({ [MERGE]: 1, [READ]: 9 });
      expect(await countersOf(replay.session_id)).toEqual({ [READ]: 1, [MERGE]: 1 });
      expect(
        (await f.store.approvals.getByRequest(first.request_id as string))?.consumedAt,
      ).not.toBeNull();

      // Past MERGE's 1/60s window (otherwise the rate limit answers first).
      const again = refused(
        await call([MERGE], { args, tool, now: at('2026-10-13T09:01:00.000Z') }),
      );
      expect(again.refusal.code).toBe('approval-required');
      expect(again.request_id).not.toBe(first.request_id); // the first was granted, not open
    });

    it('an approval is bound to the exact fingerprint: one byte changed asks again', async () => {
      const first = refused(await call([MERGE], { args, tool }));
      await grant(first.request_id as string, '2026-10-13T09:30:00.000Z');
      const other = refused(await call([MERGE], { args: { ...args, pr: 43 }, tool }));
      expect(other.refusal).toMatchObject({
        code: 'approval-required',
        fingerprint: fingerprintArguments({ ...args, pr: 43 }),
      });
      expect(await countersOf(other.session_id)).toEqual({});
    });

    it('an expired approval does not open the gate', async () => {
      const first = refused(await call([MERGE], { args, tool }));
      await grant(first.request_id as string, '2026-10-13T09:00:00.000Z');
      expect(refused(await call([MERGE], { args, tool })).refusal.code).toBe('approval-required');
    });

    it('a multi-risk call with one gated risk is refused as a whole; the others stay untouched', async () => {
      const result = refused(await call([READ, MERGE], { args, tool }));
      expect(result.refusal).toMatchObject({ code: 'approval-required', risk_id: MERGE });
      expect(await countersOf(result.session_id)).toEqual({});
    });

    it('the gate does not replace the budget: an approved action still counts', async () => {
      // MERGE quota is 2: two approved merges, the third is budget-exhausted, not
      // approval-required. Calls are spaced past MERGE's 1/60s window.
      let minute = 0;
      const next = () => at(`2026-10-13T09:0${minute++}:00.000Z`);
      for (const pr of [1, 2]) {
        const r = refused(await call([MERGE], { args: { pr }, tool, now: next() }));
        await grant(r.request_id as string, '2026-10-13T09:30:00.000Z');
        allowed(await call([MERGE], { args: { pr }, tool, now: next() }));
      }
      const third = refused(await call([MERGE], { args: { pr: 3 }, tool, now: next() }));
      expect(third.refusal).toMatchObject({ code: 'budget-exhausted', risk_id: MERGE });
      expect((await f.store.requests.listOpenForCreator(f.creatorId)).map((r) => r.kind)).toEqual([
        'claim',
      ]);
    });
  });

  it('a touched risk outside the policy aborts the transaction: no session, no counters', async () => {
    await expect(call(['stripe.refund'])).rejects.toBeInstanceOf(BudgetInvariantError);
    expect(await f.store.sessions.getByMission(f.mission.id)).toBeNull();
  });
});

describe('SessionService.stateOf', () => {
  let f: BudgetFixture;

  beforeEach(async () => {
    f = await openBudgetFixture();
  });
  afterEach(() => f.store.close());

  it('derives the state with the rollover applied on read', async () => {
    const fresh = await f.service.stateOf(f.mission, NOW);
    expect(fresh).toMatchObject({ kind: 'active', exhausted: [] });
    if (fresh.kind !== 'active') throw new Error('expected an active mission');
    expect(byRisk(fresh.remaining)).toEqual({ [READ]: 10, [WRITE]: 1, [MERGE]: 2 });
    await f.service.recordCall({
      mission: f.mission,
      tool: 't',
      args: {},
      risks_touched: [WRITE],
      now: NOW,
    });
    const spent = await f.service.stateOf(f.mission, NOW);
    expect(spent).toMatchObject({ kind: 'active', exhausted: [`${f.setId}::${WRITE}`] });
    if (spent.kind !== 'active') throw new Error('expected an active mission');
    expect(byRisk(spent.remaining)).toEqual({ [READ]: 10, [WRITE]: 0, [MERGE]: 2 });
    expect(await f.service.stateOf(f.mission, at('2026-10-14T00:00:00.000Z'))).toMatchObject({
      kind: 'active',
      period: { index: 1 },
      exhausted: [],
    });
  });

  it('reads the counters of the current period only, however old the mission is', async () => {
    for (const now of [NOW, at('2026-10-14T09:00:00.000Z'), at('2026-10-15T09:00:00.000Z')]) {
      await f.service.recordCall({
        mission: f.mission,
        tool: 'github__get_file',
        args: { repo: 'acme/app' },
        risks_touched: [READ],
        now,
      });
    }
    const session = await f.store.sessions.getByMission(f.mission.id);
    expect(await f.store.sessions.counters(session?.id ?? '')).toHaveLength(3);

    const reads: (string | undefined)[] = [];
    const sessions = {
      getByMission: (missionId: string) => f.store.sessions.getByMission(missionId),
      counters: async (sessionId: string, periodStart?: string) => {
        reads.push(periodStart);
        return f.store.sessions.counters(sessionId, periodStart);
      },
      decideAndDecrement: f.store.sessions.decideAndDecrement.bind(f.store.sessions),
    };
    const service = new SessionService({
      sessions,
      requests: f.store.requests,
      rateWindows: f.rateWindows,
      requestUrl: f.requestUrl,
      requestExpirySeconds: REQUEST_EXPIRY_SECONDS,
      approvalValiditySeconds: APPROVAL_VALIDITY_SECONDS,
    });
    const later = at('2026-10-15T10:00:00.000Z');
    const usage = await service.usageOf(f.mission, later);
    expect(usage).toMatchObject({
      session_id: session?.id,
      period: { index: 2, start: '2026-10-15T00:00:00.000Z' },
      state: { kind: 'active', remaining: { [`${f.setId}::${READ}`]: 9 } },
    });
    expect([...usage.consumed]).toEqual([[`${f.setId}::${READ}`, 1]]);
    expect(reads).toEqual(['2026-10-15T00:00:00.000Z']);

    // The Missions pages and the request page use the same read through this reader.
    const reader = missionUsageReader(sessions);
    expect(await reader.usageOf(f.mission, later)).toEqual(usage);
    expect(await reader.stateOf(f.mission, later)).toEqual(await service.stateOf(f.mission, later));
    expect(reads).toHaveLength(4);
    expect(new Set(reads)).toEqual(new Set(['2026-10-15T00:00:00.000Z']));
  });

  it('expiry and stored statuses', async () => {
    const expiring = await f.createMission({
      periodSeconds: DAY_SECONDS,
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    expect(await f.service.stateOf(expiring, NOW)).toMatchObject({ kind: 'active' });
    expect(await f.service.stateOf(expiring, at('2026-10-13T10:00:00.000Z'))).toEqual({
      kind: 'expired',
      expires_at: '2026-10-13T10:00:00.000Z',
    });
    expect(await f.service.stateOf({ ...f.mission, status: 'revoked' }, NOW)).toEqual({
      kind: 'revoked',
    });
  });
});
