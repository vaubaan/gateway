/**
 * Mission logs and the transactional decision primitive. Spec §3.3, §6 "authoritative,
 * atomic counting", §10 "atomicity on the last credit, several agents concurrent on the
 * same token". The accounting rules themselves are the budget module's; here the `decide` callbacks are
 * minimal stand-ins that compare counters to a quota.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NotFoundError,
  openStore,
  SetCatalogIndex,
  type DecideContext,
  type Store,
} from '../../../src/server/store/index.ts';
import {
  grantApprovalRequest,
  openTestStore,
  StubEncryptor,
  TEST_RISK_IDS,
  type TestStore,
} from '../../support/store/testing.ts';

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';
const MERGE = 'github.merge-protected';
const PERIOD = '2026-10-13T00:00:00.000Z';

describe('mission logs repository', () => {
  let t: TestStore;
  let store: Store;
  let missionId: string;
  let setId: string;
  let creator: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'c',
        email: 'c@x',
      })
    ).id;
    const account = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: creator },
      displayName: 'gh',
      credential: null,
    });
    const mission = await store.missions.create({
      name: 'm',
      creatorUserId: creator,
      periodAnchor: PERIOD,
      periodSeconds: 86_400,
      accounts: [{ accountId: account.id, resourceIds: [] }],
      policy: [
        { riskId: READ, quota: 10, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
        { riskId: WRITE, quota: 1, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
        { riskId: MERGE, quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' },
      ],
    });
    missionId = mission.id;
    setId = mission.accounts[0]?.resourceSets[0]?.id ?? '';
  });
  afterEach(() => store.close());

  const quotaDecider =
    (quotas: Record<string, number>) =>
    (ctx: DecideContext): { allow: boolean; event: { kind: string } } => {
      // A counter is keyed by its line, `<set>::<risk>`: the quota is the risk's.
      const allow = [...ctx.counters].every(
        ([line, consumed]) => consumed < (quotas[line.slice(line.indexOf('::') + 2)] ?? 0),
      );
      return { allow, event: { kind: allow ? 'allowed-call' : 'refused-call' } };
    };

  it('the mission log is born on the first call and never recreated', async () => {
    expect(await store.missionLogs.getByMission(missionId)).toBeNull();
    const result = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [READ], periodStart: PERIOD },
      quotaDecider({ [READ]: 10 }),
    );
    expect(result.missionLog.missionId).toBe(missionId);
    expect(result.missionLog.createdAt).toBe(t.clock.now().toISOString());
    const again = await store.missionLogs.getOrCreate(missionId);
    expect(again).toEqual(result.missionLog);
    expect(await store.missionLogs.getByMission(missionId)).toEqual(again);
  });

  it('N concurrent decisions on a quota of 1 produce exactly one allow', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.missionLogs.decideAndDecrement(
          { missionId, riskIds: [WRITE], periodStart: PERIOD },
          quotaDecider({ [WRITE]: 1 }),
        ),
      ),
    );
    const allows = results.filter((r) => r.outcome.allow);
    expect(allows).toHaveLength(1);
    expect(results.filter((r) => !r.outcome.allow)).toHaveLength(N - 1);
    const missionLog = allows[0]?.missionLog;
    if (!missionLog) throw new Error('expected a mission log');
    expect(await store.missionLogs.counters(missionLog.id, PERIOD)).toEqual([
      {
        missionLogId: missionLog.id,
        resourceSetId: setId,
        riskId: WRITE,
        periodStart: PERIOD,
        consumed: 1,
      },
    ]);
    const events = await store.missionLogs.listEvents(missionLog.id);
    expect(events.filter((e) => e.kind === 'allowed-call')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'refused-call')).toHaveLength(N - 1);
  });

  it('an unknown mission is a NotFoundError, not a foreign-key driver error', async () => {
    await expect(store.missionLogs.getOrCreate('mis_nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      store.missionLogs.decideAndDecrement(
        { missionId: 'mis_nope', riskIds: [READ], periodStart: PERIOD },
        quotaDecider({ [READ]: 1 }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('two accounts on one file: the second decision waits on the first transaction (SQLITE_BUSY)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-mission-logs-'));
    const path = join(dir, 'gateway.sqlite');
    const open = (busyTimeoutMs: number) =>
      openStore({
        path,
        encryptor: new StubEncryptor(),
        catalog: new SetCatalogIndex(TEST_RISK_IDS),
        busyTimeoutMs,
      });
    const a = open(50);
    const b = open(50);
    try {
      const user = (
        await a.users.upsertFromIdp({
          issuer: 'http://idp.test',
          subject: 'c',
          email: 'c@x',
        })
      ).id;
      const account = await a.accounts.create({
        service: 'github',
        owner: { kind: 'user', id: user },
        displayName: 'gh',
        credential: null,
      });
      const mission = await a.missions.create({
        name: 'm',
        creatorUserId: user,
        periodAnchor: PERIOD,
        periodSeconds: 86_400,
        accounts: [{ accountId: account.id, resourceIds: [] }],
        policy: [{ riskId: WRITE, quota: 1, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' }],
      });
      // A holds the write lock; B's decision cannot even read the counters until A commits.
      a.db.prepare('BEGIN IMMEDIATE').run();
      await expect(
        b.missionLogs.decideAndDecrement(
          { missionId: mission.id, riskIds: [WRITE], periodStart: PERIOD },
          quotaDecider({ [WRITE]: 1 }),
        ),
      ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
      a.db.prepare('COMMIT').run();
      const result = await b.missionLogs.decideAndDecrement(
        { missionId: mission.id, riskIds: [WRITE], periodStart: PERIOD },
        quotaDecider({ [WRITE]: 1 }),
      );
      expect(result.outcome.allow).toBe(true);
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a call touching N risks decrements N counters; a refusal decrements none', async () => {
    const allowed = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [READ, WRITE, WRITE], periodStart: PERIOD },
      quotaDecider({ [READ]: 10, [WRITE]: 1 }),
    );
    expect(allowed.outcome.allow).toBe(true);
    expect([...allowed.counters]).toEqual([
      [`${setId}::${READ}`, 1],
      [`${setId}::${WRITE}`, 1],
    ]);

    const refused = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [READ, WRITE], periodStart: PERIOD },
      quotaDecider({ [READ]: 10, [WRITE]: 1 }),
    );
    expect(refused.outcome.allow).toBe(false);
    expect([...refused.counters]).toEqual([
      [`${setId}::${READ}`, 1],
      [`${setId}::${WRITE}`, 1],
    ]);
  });

  it('period rollover is a matter of key: a new period starts at zero', async () => {
    await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [WRITE], periodStart: PERIOD },
      quotaDecider({ [WRITE]: 1 }),
    );
    const nextPeriod = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [WRITE], periodStart: '2026-10-14T00:00:00.000Z' },
      quotaDecider({ [WRITE]: 1 }),
    );
    expect(nextPeriod.outcome.allow).toBe(true);
    const missionLog = nextPeriod.missionLog;
    expect(
      (await store.missionLogs.counters(missionLog.id)).map((c) => [c.periodStart, c.consumed]),
    ).toEqual([
      [PERIOD, 1],
      ['2026-10-14T00:00:00.000Z', 1],
    ]);
  });

  it('a thrown decider rolls everything back, including the mission log creation', async () => {
    await expect(
      store.missionLogs.decideAndDecrement(
        { missionId, riskIds: [READ], periodStart: PERIOD },
        () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    expect(await store.missionLogs.getByMission(missionId)).toBeNull();
  });

  it('consumes an approval inside the decision transaction, single use', async () => {
    const missionLog = await store.missionLogs.getOrCreate(missionId);
    const request = await store.requests.create({
      missionId,
      missionLogId: missionLog.id,
      kind: 'approval',
      riskId: MERGE,
      tool: 'github__merge_pull_request',
      fingerprint: 'fp-1',
      arguments: { pr: 42 },
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    // Granted the way production grants: the approval is born in the decision transaction,
    // bound to the request's own risk, tool and fingerprint.
    const approval = await grantApprovalRequest(
      store,
      request.id,
      creator,
      '2026-10-13T09:30:00.000Z',
    );
    expect(approval).toMatchObject({
      requestId: request.id,
      riskId: MERGE,
      tool: 'github__merge_pull_request',
      fingerprint: 'fp-1',
    });
    expect(await store.requests.getById(request.id)).toMatchObject({
      state: 'granted',
      hasArguments: false,
    });

    const decide = (ctx: DecideContext) => {
      // The same arguments on another tool find nothing.
      expect(ctx.findApprovals({ tool: 'github__delete_branch', fingerprint: 'fp-1' })).toEqual([]);
      const [usable] = ctx.findApprovals({
        tool: 'github__merge_pull_request',
        fingerprint: 'fp-1',
      });
      const consumed = usable ? ctx.consumeApproval(usable.id) : null;
      return { allow: consumed !== null, approvalId: consumed?.id ?? null, event: null };
    };
    const first = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [MERGE], periodStart: PERIOD },
      decide,
    );
    expect(first.outcome).toMatchObject({ allow: true, approvalId: approval.id });
    const replay = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [MERGE], periodStart: PERIOD },
      decide,
    );
    expect(replay.outcome.allow).toBe(false);
    expect(replay.counters.get(`${setId}::${MERGE}`)).toBe(1);
    expect((await store.approvals.getByRequest(request.id))?.consumedAt).toBe(
      t.clock.now().toISOString(),
    );
  });

  it('drops a request and records extra events from inside the refusal transaction', async () => {
    const result = await store.missionLogs.decideAndDecrement(
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
      missionLogId: result.missionLog.id,
      kind: 'claim',
      state: 'open',
      riskId: WRITE,
    });
    expect((await store.requests.listOpenForCreator(creator)).map((r) => r.id)).toEqual([
      result.outcome.requestId,
    ]);
    const events = await store.missionLogs.listEvents(result.missionLog.id);
    expect(events.map((e) => e.kind)).toEqual(['request', 'refused-call']);
    expect(events[0]?.details).toEqual({ requestId: result.outcome.requestId });
  });

  it('a granted claim resets the counter of the claimed risk alone, and events are listed since a timestamp', async () => {
    const r = await store.missionLogs.decideAndDecrement(
      { missionId, riskIds: [READ, WRITE], periodStart: PERIOD },
      quotaDecider({ [READ]: 10, [WRITE]: 1 }),
    );
    // The reset production performs: inside the transaction that decides a claim.
    const claim = await store.requests.create({
      missionId,
      missionLogId: r.missionLog.id,
      kind: 'claim',
      riskId: WRITE,
      expiresAt: '2026-10-14T09:00:00.000Z',
    });
    const decided = await store.requests.decideClaim(claim.id, creator, (ctx) => ({
      state: 'granted' as const,
      decision: { resolution: 'reset-period' },
      given: ctx.resetCounter(PERIOD, { resourceSetId: setId, riskId: WRITE }),
      // Nothing left on that risk: a second reset gives nothing back and writes nothing.
      again: ctx.resetCounter(PERIOD, { resourceSetId: setId, riskId: WRITE }),
      // A risk the mission log never counted, and a period that does not exist.
      unknown: ctx.resetCounter(PERIOD, { resourceSetId: setId, riskId: 'github.never-touched' }),
      elsewhere: ctx.resetCounter('2020-01-01T00:00:00.000Z', {
        resourceSetId: setId,
        riskId: READ,
      }),
    }));
    if (decided.status !== 'decided') throw new Error('expected an open claim');
    expect(decided.outcome).toMatchObject({ given: 1, again: 0, unknown: 0, elsewhere: 0 });
    // The other risk of the period keeps what it consumed.
    expect(
      (await store.missionLogs.counters(r.missionLog.id, PERIOD)).map((c) => [
        c.riskId,
        c.consumed,
      ]),
    ).toEqual([
      [READ, 1],
      [WRITE, 0],
    ]);

    t.clock.advance(5000);
    const later = await store.missionLogs.recordEvent(r.missionLog.id, {
      kind: 'reset',
      actorUserId: creator,
      details: { by: 'claim' },
    });
    expect(later.actorUserId).toBe(creator);
    expect(await store.missionLogs.listEvents(r.missionLog.id, { since: later.ts })).toEqual([
      later,
    ]);
    expect(await store.missionLogs.listEvents(r.missionLog.id, { limit: 1 })).toHaveLength(1);

    // Additive options: filter by kind, read the tail of the timeline first.
    const all = await store.missionLogs.listEvents(r.missionLog.id);
    expect(await store.missionLogs.listEvents(r.missionLog.id, { kinds: ['reset'] })).toEqual([
      later,
    ]);
    expect(await store.missionLogs.listEvents(r.missionLog.id, { kinds: [] })).toEqual([]);
    expect(await store.missionLogs.listEvents(r.missionLog.id, { order: 'desc' })).toEqual(
      [...all].reverse(),
    );
    expect(
      await store.missionLogs.listEvents(r.missionLog.id, { order: 'desc', limit: 1 }),
    ).toEqual([later]);
    expect(
      await store.missionLogs.listEvents(r.missionLog.id, { kinds: ['reset'], since: later.ts }),
    ).toEqual([later]);
    expect(
      await store.missionLogs.listEvents(r.missionLog.id, {
        kinds: ['no-such-kind'],
        order: 'desc',
      }),
    ).toEqual([]);
  });

  it('counters and audit agree after a mixed run (structural check)', async () => {
    const decider = quotaDecider({ [READ]: 3 });
    for (let i = 0; i < 5; i++) {
      const r = await store.missionLogs.decideAndDecrement(
        { missionId, riskIds: [READ], periodStart: PERIOD },
        decider,
      );
      await store.audit.append({
        kind: 'call',
        ts: t.clock.now().toISOString(),
        mission_id: missionId,
        token_id: null,
        token_kind: null,
        token_holder: null,
        mission_log_id: r.missionLog.id,
        account_id: null,
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
        remaining_budget: { [READ]: 3 - (r.counters.get(`${setId}::${READ}`) ?? 0) },
        resource_set_ids: [setId],
        agent_label: null,
        upstream_latency_ms: null,
        upstream_error: null,
        client_ip: null,
        client_user_agent: null,
      });
      t.clock.advance(1000);
    }
    const missionLog = await store.missionLogs.getOrCreate(missionId);
    const consumed = (await store.missionLogs.counters(missionLog.id, PERIOD)).find(
      (c) => c.riskId === READ,
    );
    const audited = await store.audit.countAllowedTouches(
      missionId,
      setId,
      READ,
      PERIOD,
      '2026-10-14T00:00:00.000Z',
    );
    expect(consumed?.consumed).toBe(3);
    expect(audited).toBe(3);
  });
});
