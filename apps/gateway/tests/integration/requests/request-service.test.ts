/**
 * RequestService over the embedded store with a manual clock (spec §2.3 Request
 * states, §3.4 the claim, §4.2 the inbox): creator-only access, the four
 * resolutions and their events, the state machine against the store, expiry
 * on read and by the sweeper.
 *
 * The claim itself is dropped by the budget's `SessionService.recordCall`
 * (handbook budget-and-sessions); these tests start from its refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  BudgetMission,
  RecordCallRefused,
  RecordCallResult,
} from '../../../src/server/budget/index.ts';
import { createLogger } from '../../../src/server/logging/index.ts';
import {
  RequestService,
  type ClaimView,
  type DecideResult,
} from '../../../src/server/requests/index.ts';
import { InvariantError } from '../../../src/server/store/index.ts';
import {
  ANCHOR,
  DAY_SECONDS,
  MERGE,
  openBudgetFixture,
  READ,
  REQUEST_EXPIRY_SECONDS,
  WRITE,
  type BudgetFixture,
} from '../budget/fixture.ts';

const PUBLIC_URL = new URL('https://gateway.example.com');
const DAY1 = '2026-10-14T00:00:00.000Z';
const HOUR_MS = 3_600_000;

describe('RequestService', () => {
  let f: BudgetFixture;
  let requests: RequestService;
  const creator = () => ({ id: f.creatorId });

  beforeEach(async () => {
    f = await openBudgetFixture();
    requests = new RequestService({
      store: f.store,
      // No plugin registered: labels fall back to the risk ids.
      registry: { get: () => undefined },
      publicUrl: PUBLIC_URL,
      clock: f.clock,
      logger: createLogger({ level: 'error', redact: (text) => text, write: () => undefined }),
    });
  });
  afterEach(() => f.store.close());

  const call = (risks: readonly string[], mission: BudgetMission = f.mission) =>
    f.service.recordCall({
      mission,
      tool: 'github__push',
      args: { repo: 'acme/app' },
      risks_touched: risks,
      agent_label: 'builder',
      now: f.clock.now(),
    });

  function refused(result: RecordCallResult): RecordCallRefused & { request_id: string } {
    if (result.outcome !== 'refused' || !result.request_id) throw new Error('expected a claim');
    return { ...result, request_id: result.request_id };
  }

  /** WRITE has a quota of 1: one allowed call, then the refusal that drops the claim. */
  async function exhaust(mission: BudgetMission = f.mission): Promise<string> {
    expect((await call([WRITE], mission)).outcome).toBe('allowed');
    return refused(await call([WRITE], mission)).request_id;
  }

  async function claimView(requestId: string): Promise<ClaimView> {
    const result = await requests.view(creator(), requestId);
    if (result.outcome !== 'ok' || result.view.kind !== 'claim')
      throw new Error('expected a claim');
    return result.view;
  }

  function granted(result: DecideResult) {
    if (!result.ok) throw new Error(`expected a decision, got ${result.reason}`);
    return result.request;
  }

  const countersOf = async (periodStart = ANCHOR) => {
    const session = await f.store.sessions.getByMission(f.mission.id);
    if (!session) return {};
    return Object.fromEntries(
      (await f.store.sessions.counters(session.id, periodStart)).map((c) => [c.riskId, c.consumed]),
    );
  };

  const eventKinds = async () => {
    const session = await f.store.sessions.getByMission(f.mission.id);
    return session ? (await f.store.sessions.listEvents(session.id)).map((e) => e.kind) : [];
  };

  async function otherUser(email: string): Promise<{ id: string }> {
    return f.store.users.upsertFromIdp({ subject: email, email });
  }

  // ───────────────────────────────────────────────────────────────────────────

  describe('the inbox', () => {
    it('lists the claim for the creator, with the URL the refusal carried', async () => {
      await call([WRITE]);
      const refusal = refused(await call([WRITE]));
      expect(refusal.refusal).toMatchObject({
        code: 'budget-exhausted',
        claim_url: `https://gateway.example.com/r/${refusal.request_id}`,
      });

      const inbox = await requests.inbox(creator());
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        id: refusal.request_id,
        kind: 'claim',
        state: 'open',
        risk_id: WRITE,
        url: refusal.refusal.code === 'budget-exhausted' ? refusal.refusal.claim_url : '',
        mission: { id: f.mission.id, name: 'm' },
      });
      expect(await requests.openCount(creator())).toBe(1);
    });

    it('is empty for everyone else', async () => {
      await exhaust();
      const bob = await otherUser('bob@x');
      expect(await requests.inbox(bob)).toEqual([]);
      expect(await requests.openCount(bob)).toBe(0);
    });

    it('drops a request past its expiry even before the sweeper ran', async () => {
      const id = await exhaust();
      f.clock.advance(REQUEST_EXPIRY_SECONDS * 1000);
      expect(await requests.inbox(creator())).toEqual([]);
      expect(await requests.openCount(creator())).toBe(0);
      expect((await f.store.requests.getById(id))?.state).toBe('open');
    });
  });

  describe('creator-only access (spec §3.4)', () => {
    it('any other user is refused, and so is an unknown id: one answer', async () => {
      const id = await exhaust();
      const bob = await otherUser('bob@x');
      expect(await requests.view(bob, id)).toEqual({ outcome: 'forbidden' });
      expect(await requests.view(creator(), 'no-such-request')).toEqual({ outcome: 'forbidden' });
      expect(await requests.view(bob, 'no-such-request')).toEqual({ outcome: 'forbidden' });
    });

    it('a beneficiary of a share on the same connection is refused', async () => {
      const id = await exhaust();
      const bob = await otherUser('bob@x');
      await f.store.shares.create({
        connectionId: f.connectionId,
        target: { kind: 'user', id: bob.id },
        restriction: [READ, WRITE, MERGE],
        createdByUserId: f.creatorId,
      });
      expect(await requests.view(bob, id)).toEqual({ outcome: 'forbidden' });
      expect(await requests.decide(bob, id, { resolution: 'reset-period' })).toEqual({
        ok: false,
        reason: 'forbidden',
      });
    });

    it('a co-owner of the connection through its owner group is refused', async () => {
      const id = await exhaust();
      const bob = await otherUser('bob@x');
      const group = await f.store.groups.getOrCreate('platform', 'idp');
      await f.store.groups.addMember(group.id, bob.id);
      await f.store.groups.addMember(group.id, f.creatorId);
      await f.store.connections.transferOwner(f.connectionId, { kind: 'group', id: group.id });
      expect(await requests.view(bob, id)).toEqual({ outcome: 'forbidden' });
      // The creator still is the creator.
      expect((await requests.view(creator(), id)).outcome).toBe('ok');
    });

    it('a refused decision changes nothing', async () => {
      const id = await exhaust();
      const bob = await otherUser('bob@x');
      const before = await eventKinds();
      for (const raw of [{ resolution: 'reset-period' }, { resolution: 'refuse' }]) {
        expect(await requests.decide(bob, id, raw)).toEqual({ ok: false, reason: 'forbidden' });
      }
      expect(await requests.decideClaim(bob, id, { resolution: 'reset-period' })).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      expect((await f.store.requests.getById(id))?.state).toBe('open');
      expect(await countersOf()).toEqual({ [WRITE]: 1 });
      expect(await eventKinds()).toEqual(before);
    });
  });

  describe('the creator’s view', () => {
    it('shows the risk, the other risks, the period, the events and the four actions', async () => {
      await call([READ]);
      await call([READ]);
      const id = await exhaust();
      const view = await claimView(id);

      expect(view.mission).toEqual({
        id: f.mission.id,
        name: 'm',
        state: 'active',
        expires_at: null,
      });
      expect(view.period).toEqual({ index: 0, start: ANCHOR, end: DAY1 });
      expect(view.risk).toEqual({
        risk_id: WRITE,
        label: WRITE,
        quota: 1,
        consumed: 1,
        remaining: 0,
      });
      expect(view.other_risks).toEqual([
        { risk_id: READ, label: READ, quota: 10, consumed: 2, remaining: 8 },
        { risk_id: MERGE, label: MERGE, quota: 2, consumed: 0, remaining: 2 },
      ]);
      // Most recent first: the refusal, the claim it dropped, then the allowed calls.
      expect(view.events.map((e) => e.kind).sort()).toEqual(
        ['call-allowed', 'call-allowed', 'call-allowed', 'call-refused', 'request'].sort(),
      );
      expect(view.events.at(-1)?.kind).toBe('call-allowed');
      expect(view.events.find((e) => e.kind === 'call-refused')?.summary).toBe(
        'Refused github__push (budget-exhausted) by “builder”',
      );
      expect(view.options.map((o) => [o.resolution, o.unavailable?.code ?? null])).toEqual([
        ['reset-period', null],
        ['extend-quota', null],
        ['extend-expiry', 'no-expiry'],
        ['refuse', null],
      ]);
    });

    it('after the period rolled over, the risk reads un-exhausted and there is nothing to give back', async () => {
      const id = await exhaust();
      f.clock.set('2026-10-14T01:00:00.000Z'); // next period, request still open (24 h)
      const view = await claimView(id);
      expect(view.request.state).toBe('open');
      expect(view.period.start).toBe(DAY1);
      expect(view.risk).toMatchObject({ consumed: 0, remaining: 1 });
      expect(view.options.find((o) => o.resolution === 'extend-quota')?.unavailable?.code).toBe(
        'nothing-consumed',
      );
    });

    it('an approval request gets a neutral view and no decision in this version', async () => {
      const approval = await f.store.requests.create({
        missionId: f.mission.id,
        kind: 'approval',
        riskId: MERGE,
        tool: 'github__merge',
        fingerprint: 'f'.repeat(64),
        arguments: { pr: 1 },
        expiresAt: '2026-10-14T09:00:00.000Z',
      });
      const result = await requests.view(creator(), approval.id);
      expect(result).toMatchObject({
        outcome: 'ok',
        view: { kind: 'approval', request: { id: approval.id, state: 'open', risk_id: MERGE } },
      });
      expect(await requests.decide(creator(), approval.id, { resolution: 'reset-period' })).toEqual(
        { ok: false, reason: 'unsupported-kind', kind: 'approval' },
      );
      expect(await requests.decideClaim(creator(), approval.id, { resolution: 'refuse' })).toEqual({
        ok: false,
        reason: 'unsupported-kind',
        kind: 'approval',
      });
      // The store's claim primitive refuses it too; the approval is left intact.
      await expect(
        f.store.requests.decideClaim(approval.id, f.creatorId, () => ({
          state: 'granted',
          decision: {},
        })),
      ).rejects.toBeInstanceOf(InvariantError);
      expect(await f.store.requests.getById(approval.id)).toMatchObject({
        state: 'open',
        hasArguments: true,
      });
      // It is in the inbox all the same.
      expect((await requests.inbox(creator())).map((r) => r.kind)).toEqual(['approval']);
    });
  });

  describe('reset the period', () => {
    it('zeroes every counter of the period, records the event, and the replay passes', async () => {
      await call([READ]);
      const id = await exhaust();
      const decided = granted(await requests.decide(creator(), id, { resolution: 'reset-period' }));

      expect(decided).toMatchObject({
        id,
        state: 'granted',
        decision: {
          resolution: 'reset-period',
          period_start: ANCHOR,
          period_end: DAY1,
          credits: { [READ]: 1, [WRITE]: 1 },
        },
      });
      expect(await countersOf()).toEqual({ [READ]: 0, [WRITE]: 0 });

      const session = await f.store.sessions.getByMission(f.mission.id);
      const [event] = await f.store.sessions.listEvents(session!.id, { kinds: ['reset'] });
      expect(event).toMatchObject({
        kind: 'reset',
        riskId: WRITE,
        actorUserId: f.creatorId,
        details: { request_id: id, period_start: ANCHOR, credits: { [READ]: 1, [WRITE]: 1 } },
      });

      // The token did not change; the executor replays its call.
      expect((await call([WRITE])).outcome).toBe('allowed');
      expect(await requests.inbox(creator())).toEqual([]);
    });

    it('writes an admin audit entry naming the request', async () => {
      const id = await exhaust();
      await requests.decide(creator(), id, { resolution: 'reset-period' });
      const entries = await f.store.audit.list({ kind: 'admin' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'admin',
        user_id: f.creatorId,
        act: 'period-reset',
        object: { type: 'request', id },
        after: { mission_id: f.mission.id, risk_id: WRITE, resolution: 'reset-period' },
      });
    });
  });

  describe('extend the quota for the current period', () => {
    it('gives back the chosen number of actions on the claimed risk only', async () => {
      await call([READ]);
      const id = await exhaust();
      const decided = granted(
        await requests.decide(creator(), id, { resolution: 'extend-quota', amount: 1 }),
      );
      expect(decided.decision).toMatchObject({ resolution: 'extend-quota', amount: 1 });
      expect(await countersOf()).toEqual({ [READ]: 1, [WRITE]: 0 });

      // One more action, then exhausted again: the policy did not change.
      expect((await call([WRITE])).outcome).toBe('allowed');
      const again = refused(await call([WRITE]));
      expect(again.request_id).not.toBe(id);
      expect((await f.store.missions.getById(f.mission.id))?.policy).toContainEqual(
        expect.objectContaining({ riskId: WRITE, quota: 1 }),
      );

      const entries = await f.store.audit.list({ kind: 'admin' });
      expect(entries[0]).toMatchObject({
        act: 'budget-extended',
        after: { amount: 1, consumed: 0 },
      });
    });

    it('does not carry over: the next period starts from the mission’s quota', async () => {
      const id = await exhaust();
      await requests.decide(creator(), id, { resolution: 'extend-quota', amount: 1 });
      f.clock.set('2026-10-14T09:00:00.000Z');
      expect((await call([WRITE])).outcome).toBe('allowed');
      expect((await call([WRITE])).outcome).toBe('refused');
    });

    it('refuses more than what was consumed and leaves the request open', async () => {
      const id = await exhaust();
      const result = await requests.decide(creator(), id, {
        resolution: 'extend-quota',
        amount: 2,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'invalid',
        problem: { code: 'invalid-amount' },
      });
      expect((await f.store.requests.getById(id))?.state).toBe('open');
      expect(await countersOf()).toEqual({ [WRITE]: 1 });
      expect(await f.store.audit.list({ kind: 'admin' })).toEqual([]);
    });

    it('the store never lets a counter go below zero', async () => {
      const id = await exhaust();
      const result = await f.store.requests.decideClaim(id, f.creatorId, (ctx) => {
        expect(ctx.creditCounter(ANCHOR, WRITE, 2)).toBe(false);
        expect(ctx.creditCounter(ANCHOR, WRITE, 0)).toBe(false);
        expect(ctx.creditCounter(ANCHOR, READ, 1)).toBe(false); // no row at all
        expect(ctx.creditCounter(ANCHOR, WRITE, 1)).toBe(true);
        return { state: 'granted', decision: { test: true } };
      });
      expect(result.status).toBe('decided');
      expect(await countersOf()).toEqual({ [WRITE]: 0 });
    });
  });

  describe('extend the expiry', () => {
    it('moves the expiry; the risk stays exhausted until the next period', async () => {
      const mission = await f.createMission({
        periodSeconds: DAY_SECONDS,
        expiresAt: '2026-10-20T00:00:00.000Z',
      });
      const id = await exhaust(mission);
      const decided = granted(
        await requests.decide(creator(), id, {
          resolution: 'extend-expiry',
          expires_at: '2026-11-01T00:00',
        }),
      );
      expect(decided.decision).toEqual({
        resolution: 'extend-expiry',
        expires_at_before: '2026-10-20T00:00:00.000Z',
        expires_at: '2026-11-01T00:00:00.000Z',
      });
      expect((await f.store.missions.getById(mission.id))?.expiresAt).toBe(
        '2026-11-01T00:00:00.000Z',
      );
      expect((await call([WRITE], mission)).outcome).toBe('refused');
      expect((await f.store.audit.list({ kind: 'admin' }))[0]).toMatchObject({
        act: 'expiry-extended',
        before: { expires_at: '2026-10-20T00:00:00.000Z' },
      });
    });

    it('refuses a date that is not later, and a mission that never expires', async () => {
      const mission = await f.createMission({
        periodSeconds: DAY_SECONDS,
        expiresAt: '2026-10-20T00:00:00.000Z',
      });
      const id = await exhaust(mission);
      expect(
        await requests.decide(creator(), id, {
          resolution: 'extend-expiry',
          expires_at: '2026-10-19T00:00:00.000Z',
        }),
      ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'invalid-expiry' } });

      const forever = await exhaust();
      expect(
        await requests.decide(creator(), forever, {
          resolution: 'extend-expiry',
          expires_at: '2027-01-01T00:00:00.000Z',
        }),
      ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'no-expiry' } });
    });

    it('brings a mission stored as expired back to active', async () => {
      const mission = await f.createMission({
        periodSeconds: DAY_SECONDS,
        expiresAt: '2026-10-13T12:00:00.000Z',
      });
      const id = await exhaust(mission);
      f.clock.set('2026-10-13T13:00:00.000Z');
      await f.store.missions.setStatus(mission.id, 'expired');

      const view = await claimView(id);
      expect(view.mission.state).toBe('expired');
      expect(view.options.filter((o) => !o.unavailable).map((o) => o.resolution)).toEqual([
        'extend-expiry',
        'refuse',
      ]);
      expect(await requests.decide(creator(), id, { resolution: 'reset-period' })).toMatchObject({
        ok: false,
        reason: 'invalid',
        problem: { code: 'mission-expired' },
      });

      granted(
        await requests.decide(creator(), id, {
          resolution: 'extend-expiry',
          expires_at: '2026-10-20T00:00:00.000Z',
        }),
      );
      expect(await f.store.missions.getById(mission.id)).toMatchObject({
        status: 'active',
        expiresAt: '2026-10-20T00:00:00.000Z',
        closedAt: null,
      });
    });
  });

  describe('refuse', () => {
    it('keeps the risk exhausted until the next period and the mission usable otherwise', async () => {
      const id = await exhaust();
      const decided = granted(await requests.decide(creator(), id, { resolution: 'refuse' }));
      expect(decided).toMatchObject({ state: 'refused', decision: { resolution: 'refuse' } });
      expect(await countersOf()).toEqual({ [WRITE]: 1 });

      // Still exhausted: the replay is refused and opens a new claim.
      const again = refused(await call([WRITE]));
      expect(again.request_id).not.toBe(id);
      // The mission is not closed: its other risks pass.
      expect((await call([READ])).outcome).toBe('allowed');
      expect(await f.service.stateOf(f.mission, f.clock.now())).toMatchObject({
        kind: 'active',
        exhausted: [WRITE],
      });
      // Next period: the quota is back without anyone granting anything.
      f.clock.set('2026-10-14T00:00:01.000Z');
      expect((await call([WRITE])).outcome).toBe('allowed');

      expect((await f.store.audit.list({ kind: 'admin' }))[0]).toMatchObject({
        act: 'request-refused',
        object: { type: 'request', id },
      });
      const session = await f.store.sessions.getByMission(f.mission.id);
      const events = await f.store.sessions.listEvents(session!.id, { kinds: ['request'] });
      expect(events.map((e) => e.details?.state ?? 'dropped')).toEqual([
        'dropped',
        'refused',
        'dropped',
      ]);
    });

    it('a revoked mission leaves only the refusal', async () => {
      const id = await exhaust();
      await f.store.missions.setStatus(f.mission.id, 'revoked');
      expect(await requests.decide(creator(), id, { resolution: 'reset-period' })).toMatchObject({
        ok: false,
        reason: 'invalid',
        problem: { code: 'mission-closed' },
      });
      expect(granted(await requests.decide(creator(), id, { resolution: 'refuse' })).state).toBe(
        'refused',
      );
    });
  });

  describe('state machine against the store', () => {
    it.each([
      ['reset-period', 'granted'],
      ['refuse', 'refused'],
    ] as const)(
      'a request decided by %s is %s and cannot be decided again',
      async (resolution, state) => {
        const id = await exhaust();
        expect(granted(await requests.decide(creator(), id, { resolution })).state).toBe(state);
        for (const second of ['reset-period', 'refuse'] as const) {
          expect(await requests.decide(creator(), id, { resolution: second })).toEqual({
            ok: false,
            reason: 'not-open',
            state,
          });
        }
        expect((await f.store.requests.getById(id))?.state).toBe(state);
        expect(await f.store.audit.list({ kind: 'admin' })).toHaveLength(1);
        expect((await claimView(id)).options).toEqual([]);
      },
    );

    it('a body that is not a decision is refused before anything is read', async () => {
      const id = await exhaust();
      expect(await requests.decide(creator(), id, { resolution: 'approve-all' })).toMatchObject({
        ok: false,
        reason: 'invalid',
        problem: { code: 'invalid-decision' },
      });
      expect((await f.store.requests.getById(id))?.state).toBe('open');
    });

    it('a failing effect rolls the whole decision back', async () => {
      const id = await exhaust();
      await expect(
        f.store.requests.decideClaim(id, f.creatorId, (ctx) => {
          ctx.resetCounters(ANCHOR);
          ctx.recordEvent({ kind: 'reset' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await f.store.requests.getById(id))?.state).toBe('open');
      expect(await countersOf()).toEqual({ [WRITE]: 1 });
      expect(await eventKinds()).not.toContain('reset');
    });

    it('an overdue request is expired by the decision attempt itself', async () => {
      const id = await exhaust();
      f.clock.advance(REQUEST_EXPIRY_SECONDS * 1000);
      const view = await claimView(id);
      expect(view.request.state).toBe('expired');
      expect(view.options).toEqual([]);

      expect(await requests.decide(creator(), id, { resolution: 'reset-period' })).toEqual({
        ok: false,
        reason: 'not-open',
        state: 'expired',
      });
      expect((await f.store.requests.getById(id))?.state).toBe('expired');
      expect(await countersOf()).toEqual({ [WRITE]: 1 });
    });
  });

  describe('expiry sweep', () => {
    it('flips unanswered requests to expired, once, with an event each', async () => {
      const other = await f.createMission({ periodSeconds: null });
      const first = await exhaust();
      f.clock.advance(HOUR_MS);
      const second = await exhaust(other);

      expect(await requests.sweep()).toBe(0);
      // 24 h after the first, 23 h after the second.
      f.clock.advance(REQUEST_EXPIRY_SECONDS * 1000 - HOUR_MS);
      expect(await requests.sweep()).toBe(1);
      expect((await f.store.requests.getById(first))?.state).toBe('expired');
      expect((await f.store.requests.getById(second))?.state).toBe('open');

      f.clock.advance(HOUR_MS);
      expect(await requests.sweep()).toBe(1);
      expect((await f.store.requests.getById(second))?.state).toBe('expired');
      expect(await requests.sweep()).toBe(0);

      const session = await f.store.sessions.getByMission(f.mission.id);
      const events = await f.store.sessions.listEvents(session!.id, { kinds: ['request'] });
      expect(events.at(-1)).toMatchObject({
        riskId: WRITE,
        details: { request_id: first, request_kind: 'claim', state: 'expired' },
      });
    });

    it('leaves decided requests alone', async () => {
      const id = await exhaust();
      await requests.decide(creator(), id, { resolution: 'refuse' });
      f.clock.advance(2 * REQUEST_EXPIRY_SECONDS * 1000);
      expect(await requests.sweep()).toBe(0);
      expect((await f.store.requests.getById(id))?.state).toBe('refused');
    });

    it('an expired claim does not close the mission: the risk stays exhausted, the rest runs', async () => {
      const oneOff = await f.createMission({ periodSeconds: null });
      const id = await exhaust(oneOff);
      f.clock.advance(REQUEST_EXPIRY_SECONDS * 1000);
      await requests.sweep();
      expect(await f.service.stateOf(oneOff, f.clock.now())).toMatchObject({
        kind: 'active',
        exhausted: [WRITE],
      });
      expect((await call([READ], oneOff)).outcome).toBe('allowed');
      // The next refused call opens a new claim instead of reusing the expired one.
      expect(refused(await call([WRITE], oneOff)).request_id).not.toBe(id);
    });

    it('erases the sealed arguments of an expired approval request', async () => {
      const approval = await f.store.requests.create({
        missionId: f.mission.id,
        kind: 'approval',
        riskId: MERGE,
        tool: 'github__merge',
        fingerprint: 'f'.repeat(64),
        arguments: { pr: 1 },
        expiresAt: '2026-10-13T09:10:00.000Z',
      });
      f.clock.advance(HOUR_MS);
      expect(await requests.sweep()).toBe(1);
      expect(await f.store.requests.getById(approval.id)).toMatchObject({
        state: 'expired',
        hasArguments: false,
      });
    });
  });
});
