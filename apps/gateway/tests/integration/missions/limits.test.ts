/**
 * The limits of a mission, changed after issuance by its creator (spec §3.2; ADR
 * mission-editable-after-issuance). Over the real composition root: the
 * mission service, its HTTP handler, the store and the budget the execution door
 * decides with.
 *
 * What is proven here:
 *
 *   - per accepted risk, the quota and the calls per rate window move up or down;
 *     nothing else moves (the list of risks, the gate, the window, the period);
 *   - a change is judged by issuance's own check (`checkPolicyLines`): the catalog's
 *     rate ceiling, whole numbers of at least one, the creator's authority now;
 *   - it applies at once to the current period: what was used stays used, and a
 *     quota under it leaves the risk exhausted until the reset;
 *   - no call decided after the change commits passes above the new limit, even one
 *     whose mission was loaded before it (the race);
 *   - the creator only: a teammate, an operator, another user are told "not found";
 *     a revoked or orphaned mission is not changed;
 *   - one `limits-changed` entry with before and after; one session event per risk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf } from '../../../src/server/budget';
import { seedConnection } from '../../support/missions/testing';
import type { MissionRecord } from '../../../src/server/store/types';
import {
  issueMission,
  MERGE,
  openAuditRig,
  PR,
  READ,
  seedCall,
  type OperatorRig,
} from '../audit/support';
import { PUBLIC_URL, sessionHeaders } from './support';

const REFUND = 'stripe[test].refund-create';

describe('changing the limits of a mission after issuance', () => {
  let rig: OperatorRig;
  /** READ quota 5, PR quota 2, MERGE quota 2 under approval; every rate 50 a minute. */
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    mission = await issueMission(rig);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const service = () => rig.root.missions.service;
  const fresh = async (id = mission.id): Promise<MissionRecord> => {
    const record = await rig.root.store.missions.getById(id);
    if (!record) throw new Error('the mission vanished');
    return record;
  };
  const entryOf = async (riskId: string) =>
    (await fresh()).policy.find((entry) => entry.riskId === riskId);
  /** One call as the door records it, on the mission as `stored` holds it (stale or not). */
  const call = async (stored: MissionRecord, riskId = READ, n = 1) =>
    (await seedCall(rig, stored, { tool: 'github__tool', risks: [riskId], args: { n } })).result;
  const limitEdits = async () =>
    (await rig.root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.act === 'limits-changed' ? [e] : [],
    );
  const events = async () => {
    const session = await rig.root.store.sessions.getByMission(mission.id);
    return session ? rig.root.store.sessions.listEvents(session.id) : [];
  };

  it('raises and lowers a quota and a rate; nothing else of the mission moves', async () => {
    const before = await fresh();
    const result = await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: READ, quota: 9, rate_limit_max: 4 },
      { risk_id: PR, quota: 1, rate_limit_max: 50 },
    ]);
    expect(result).toMatchObject({
      ok: true,
      changed: [
        {
          risk_id: READ,
          before: { quota: 5, rate_limit: { max: 50, window_seconds: 60 } },
          after: { quota: 9, rate_limit: { max: 4, window_seconds: 60 } },
        },
        {
          risk_id: PR,
          before: { quota: 2, rate_limit: { max: 50, window_seconds: 60 } },
          after: { quota: 1, rate_limit: { max: 50, window_seconds: 60 } },
        },
      ],
    });
    const after = await fresh();
    expect(after.policy).toEqual(
      before.policy.map((entry) =>
        entry.riskId === READ
          ? { ...entry, quota: 9, rateLimit: 4 }
          : entry.riskId === PR
            ? { ...entry, quota: 1 }
            : entry,
      ),
    );
    expect(after.connections).toEqual(before.connections);
    expect(after.periodSeconds).toBe(before.periodSeconds);
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  it('applies at once to the current period: what was used stays used, a lower quota exhausts the risk until the reset', async () => {
    for (let n = 1; n <= 3; n += 1)
      expect((await call(await fresh(), READ, n)).outcome).toBe('allowed');

    // Lowered under what was used: exhausted, the three calls stay counted.
    await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: READ, quota: 2, rate_limit_max: 50 },
    ]);
    const refused = await call(await fresh(), READ, 4);
    expect(refused).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'budget-exhausted', risk_id: READ, quota: 2, consumed: 3 },
    });
    const detail = await service().get(rig.seeded.ada, mission.id);
    expect(detail?.state).toMatchObject({ kind: 'active', exhausted: [READ] });
    // The other risks of the mission keep working.
    expect((await call(await fresh(), PR)).outcome).toBe('allowed');

    // Raised again: the calls used still count, the room is what is left above them.
    await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: READ, quota: 4, rate_limit_max: 50 },
    ]);
    expect(await call(await fresh(), READ, 5)).toMatchObject({
      outcome: 'allowed',
      remaining: { [READ]: 0 },
    });
    expect((await call(await fresh(), READ, 6)).outcome).toBe('refused');

    // The next period starts from zero under the new limit.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const next = await seedCall(rig, await fresh(), {
      tool: 'github__tool',
      risks: [READ],
      args: { n: 7 },
      now: tomorrow,
    });
    expect(next.result).toMatchObject({ outcome: 'allowed', remaining: { [READ]: 3 } });
  });

  it('a call decided after the change uses the new limit, even when its mission was loaded before (the race)', async () => {
    const stale = await fresh();
    expect((await call(stale, READ, 1)).outcome).toBe('allowed');
    await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: READ, quota: 1, rate_limit_max: 50 },
    ]);
    // `stale` still says quota 5: the decision reads the stored limit in its transaction.
    expect(await call(stale, READ, 2)).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'budget-exhausted', quota: 1, consumed: 1 },
    });
  });

  it('calls in flight while the limit drops: none passes above the new limit', async () => {
    const stale = budgetMissionOf(await fresh());
    // Ten calls start on the mission as loaded (quota 5), and the limit drops to 2 before
    // any of them reaches its decision: each one yields once before its transaction.
    const inFlight = Array.from({ length: 10 }, (_, n) =>
      rig.root.budget.recordCall({
        mission: stale,
        tool: 'github__tool',
        args: { n },
        risks_touched: [READ],
        now: new Date(),
      }),
    );
    const dropped = rig.root.store.missions.setLimits(
      mission.id,
      [{ riskId: READ, quota: 2, rateLimit: 50 }],
      rig.seeded.ada.id,
    );
    const results = await Promise.all(inFlight);
    await dropped;
    expect(results.filter((r) => r.outcome === 'allowed')).toHaveLength(2);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(8);

    // The rate the same: lowered to one call a minute while the quota is raised.
    await rig.root.store.missions.setLimits(
      mission.id,
      [{ riskId: PR, quota: 2, rateLimit: 1 }],
      rig.seeded.ada.id,
    );
    const rated = await Promise.all(
      [1, 2].map((n) =>
        rig.root.budget.recordCall({
          mission: stale,
          tool: 'github__tool',
          args: { n },
          risks_touched: [PR],
          now: new Date(),
        }),
      ),
    );
    expect(rated.map((r) => r.outcome).sort()).toEqual(['allowed', 'refused']);
    expect(rated.find((r) => r.outcome === 'refused')).toMatchObject({
      refusal: { code: 'rate-limited', limit: { max: 1, window_seconds: 60 } },
    });
  });

  it('writes one administrative entry with before and after, and one session event per risk that moved', async () => {
    // Before the first call there is no session: the entry is written, no event.
    await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: PR, quota: 3, rate_limit_max: 50 },
    ]);
    expect(await limitEdits()).toMatchObject([
      {
        user_id: rig.seeded.ada.id,
        object: { type: 'mission', id: mission.id },
        before: {
          limits: [{ risk_id: PR, quota: 2, rate_limit: { max: 50, window_seconds: 60 } }],
        },
        after: { limits: [{ risk_id: PR, quota: 3, rate_limit: { max: 50, window_seconds: 60 } }] },
        delegated_client_id: null,
      },
    ]);
    expect(await events()).toEqual([]);

    await call(await fresh());
    // Two risks change in one act; a third is listed with its own values and does not move.
    await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: READ, quota: 8, rate_limit_max: 50 },
      { risk_id: MERGE, quota: 2, rate_limit_max: 5 },
      { risk_id: PR, quota: 3, rate_limit_max: 50 },
    ]);
    const edits = await limitEdits();
    expect(edits).toHaveLength(2);
    expect(edits[1]?.before).toEqual({
      limits: [
        { risk_id: READ, quota: 5, rate_limit: { max: 50, window_seconds: 60 } },
        { risk_id: MERGE, quota: 2, rate_limit: { max: 50, window_seconds: 60 } },
      ],
    });
    expect(edits[1]?.after).toEqual({
      limits: [
        { risk_id: READ, quota: 8, rate_limit: { max: 50, window_seconds: 60 } },
        { risk_id: MERGE, quota: 2, rate_limit: { max: 5, window_seconds: 60 } },
      ],
    });
    expect((await events()).filter((e) => e.kind === 'limits-changed')).toMatchObject([
      {
        riskId: READ,
        actorUserId: rig.seeded.ada.id,
        details: { quota: 8, quota_before: 5, rate_limit_max: 50, rate_limit_max_before: 50 },
      },
      {
        riskId: MERGE,
        details: { quota: 2, quota_before: 2, rate_limit_max: 5, rate_limit_max_before: 50 },
      },
    ]);
  });

  it('values equal to the stored ones change nothing and record nothing', async () => {
    await call(await fresh());
    const updatedAt = (await fresh()).updatedAt;
    const result = await service().setLimits(rig.seeded.ada, mission.id, [
      { risk_id: READ, quota: 5, rate_limit_max: 50 },
    ]);
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(await limitEdits()).toEqual([]);
    expect((await events()).map((e) => e.kind)).not.toContain('limits-changed');
    expect((await fresh()).updatedAt).toBe(updatedAt);
  });

  it('never adds a permission, never takes a list it cannot read, never a number issuance refuses', async () => {
    expect(
      await service().setLimits(rig.seeded.ada, mission.id, [
        { risk_id: 'github.bulk-file-write', quota: 1, rate_limit_max: 1 },
      ]),
    ).toEqual({ ok: false, reason: 'risk-not-in-policy', risk_ids: ['github.bulk-file-write'] });
    expect(await service().setLimits(rig.seeded.ada, mission.id, [])).toMatchObject({
      ok: false,
      reason: 'invalid-limits',
    });
    expect(
      await service().setLimits(rig.seeded.ada, mission.id, [
        { risk_id: READ, quota: 6, rate_limit_max: 50 },
        { risk_id: READ, quota: 7, rate_limit_max: 50 },
      ]),
    ).toMatchObject({ ok: false, reason: 'invalid-limits' });
    for (const [quota, rate] of [
      [0, 50],
      [2.5, 50],
      [5, 0],
      [-1, 50],
    ] as const) {
      const refused = await service().setLimits(rig.seeded.ada, mission.id, [
        { risk_id: READ, quota, rate_limit_max: rate },
      ]);
      expect(refused).toMatchObject({
        ok: false,
        reason: 'refused',
        issues: [{ code: 'invalid-budget', risk_ids: [READ] }],
      });
    }
    expect(await entryOf(READ)).toMatchObject({ quota: 5, rateLimit: 50 });
    expect((await fresh()).policy.map((e) => e.riskId).sort()).toEqual([MERGE, PR, READ].sort());
    expect(await limitEdits()).toEqual([]);
  });

  it('a raise is capped as at creation: the catalog ceiling refuses the change with issuance’s own words', async () => {
    const stripe = await seedConnection(rig.root.store, {
      provider: 'stripe',
      owner: { kind: 'user', id: rig.seeded.ada.id },
      displayName: 'Acme Stripe',
      resources: [{ ref: 'acct_test', displayName: 'acme (test)', env: 'test' }],
    });
    const draft = (max: number) => ({
      name: 'Refund the duplicates',
      connections: [
        {
          connection_id: stripe.connection.id,
          policy: [{ risk_id: REFUND, quota: 2, rate_limit: { max, window_seconds: 60 } }],
        },
      ],
      period: { kind: 'recurring' as const, length_seconds: 86_400 },
      expires_at: null,
    });
    const refunds = await issueMission(rig, rig.seeded.ada, draft(10));

    const refused = await service().setLimits(rig.seeded.ada, refunds.id, [
      { risk_id: REFUND, quota: 2, rate_limit_max: 31 },
    ]);
    // The same issue, word for word, as a creation asking for that rate.
    const preview = await service().preview(rig.seeded.ada, draft(31));
    expect(preview.ok).toBe(false);
    if (refused.ok || refused.reason !== 'refused') throw new Error('expected a refusal');
    expect(refused.issues.map(({ code, message }) => ({ code, message }))).toEqual(
      preview.issues.map(({ code, message }) => ({ code, message })),
    );
    expect(refused.issues[0]?.message).toContain('catalog ceiling of 30 per minute');

    // At the ceiling, and a quota with no ceiling, pass.
    expect(
      await service().setLimits(rig.seeded.ada, refunds.id, [
        { risk_id: REFUND, quota: 500, rate_limit_max: 30 },
      ]),
    ).toMatchObject({ ok: true, changed: [{ risk_id: REFUND }] });
  });

  it('the creator only: a teammate, an operator and another user are answered as for an unknown mission', async () => {
    const added = await rig.root.missions.team.addMember(rig.seeded.ada, mission.id, {
      email: rig.seeded.bob.email,
    });
    expect(added.ok).toBe(true);
    for (const user of [rig.seeded.bob, rig.operator]) {
      expect(
        await service().setLimits(user, mission.id, [
          { risk_id: READ, quota: 99, rate_limit_max: 50 },
        ]),
      ).toEqual({ ok: false, reason: 'not-found' });
    }
    expect(
      await service().setLimits(rig.seeded.ada, 'no-such-mission', [
        { risk_id: READ, quota: 9, rate_limit_max: 50 },
      ]),
    ).toEqual({ ok: false, reason: 'not-found' });
    expect(await entryOf(READ)).toMatchObject({ quota: 5 });
    const detail = await service().get(rig.seeded.bob, mission.id);
    expect(detail?.limits_editable).toBe(false);
    expect((await service().get(rig.seeded.ada, mission.id))?.limits_editable).toBe(true);
  });

  it('an orphaned or a stopped mission is not changed; an expired one is, as its gates are', async () => {
    await rig.root.store.missions.setExpiresAt(mission.id, '2020-01-01T00:00:00.000Z');
    expect(
      await service().setLimits(rig.seeded.ada, mission.id, [
        { risk_id: READ, quota: 6, rate_limit_max: 50 },
      ]),
    ).toMatchObject({ ok: true });
    await rig.root.store.missions.setExpiresAt(mission.id, null);

    await rig.root.store.connections.revoke(rig.seeded.github.connection.id);
    expect(
      await service().setLimits(rig.seeded.ada, mission.id, [
        { risk_id: READ, quota: 50, rate_limit_max: 50 },
      ]),
    ).toEqual({ ok: false, reason: 'inactive', state: 'orphaned' });
    expect((await service().get(rig.seeded.ada, mission.id))?.limits_editable).toBe(false);

    await service().revoke(rig.seeded.ada, mission.id);
    expect(
      await service().setLimits(rig.seeded.ada, mission.id, [
        { risk_id: READ, quota: 50, rate_limit_max: 50 },
      ]),
    ).toEqual({ ok: false, reason: 'inactive', state: 'revoked' });
    expect(await entryOf(READ)).toMatchObject({ quota: 6 });
  });

  describe('POST /api/missions/:id/limits', () => {
    const handler = () => rig.root.missions.handlers;
    function limitsRequest(headers: Headers, body: unknown, id = mission.id): Request {
      return new Request(`${PUBLIC_URL}/api/missions/${id}/limits`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    }

    it('200 for the creator, with what moved', async () => {
      const response = await handler().setLimits(
        limitsRequest(await sessionHeaders(rig.root, rig.seeded.ada), {
          limits: [{ risk_id: READ, quota: 12, rate_limit: { max: 6 } }],
        }),
        mission.id,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        mission: { id: mission.id },
        changed: [
          {
            risk_id: READ,
            before: { quota: 5, rate_limit: { max: 50, window_seconds: 60 } },
            after: { quota: 12, rate_limit: { max: 6, window_seconds: 60 } },
          },
        ],
      });
    });

    it.each([
      ['not JSON', '{'],
      ['no list', {}],
      ['an empty list', { limits: [] }],
      ['a line without a rate', { limits: [{ risk_id: READ, quota: 3 }] }],
      [
        'a quota that is a string',
        { limits: [{ risk_id: READ, quota: '3', rate_limit: { max: 1 } }] },
      ],
      // The window, the gate and the period are not part of a change of limits.
      [
        'a window',
        { limits: [{ risk_id: READ, quota: 3, rate_limit: { max: 1, window_seconds: 1 } }] },
      ],
      ['a gate', { limits: [{ risk_id: READ, quota: 3, rate_limit: { max: 1 }, gate: 'auto' }] }],
      ['a period', { limits: [{ risk_id: READ, quota: 3, rate_limit: { max: 1 } }], period: 60 }],
      ['a list at the top', [{ risk_id: READ, quota: 3, rate_limit: { max: 1 } }]],
    ])('400 for %s', async (_what, body) => {
      const response = await handler().setLimits(
        limitsRequest(await sessionHeaders(rig.root, rig.seeded.ada), body),
        mission.id,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid-limits-edit' });
      expect(await entryOf(READ)).toMatchObject({ quota: 5, rateLimit: 50, rateWindowSeconds: 60 });
    });

    it('404 for anyone else, 422 outside the policy or refused as at creation, 409 for a stopped mission, 403 cross-origin', async () => {
      const edit = { limits: [{ risk_id: READ, quota: 99, rate_limit: { max: 50 } }] };
      for (const user of [rig.operator, rig.seeded.bob]) {
        const response = await handler().setLimits(
          limitsRequest(await sessionHeaders(rig.root, user), edit),
          mission.id,
        );
        expect(response.status).toBe(404);
      }
      const outside = await handler().setLimits(
        limitsRequest(await sessionHeaders(rig.root, rig.seeded.ada), {
          limits: [{ risk_id: 'github.bulk-file-write', quota: 1, rate_limit: { max: 1 } }],
        }),
        mission.id,
      );
      expect(outside.status).toBe(422);
      expect(await outside.json()).toMatchObject({ error: 'risk-not-in-policy' });
      const zero = await handler().setLimits(
        limitsRequest(await sessionHeaders(rig.root, rig.seeded.ada), {
          limits: [{ risk_id: READ, quota: 0, rate_limit: { max: 1 } }],
        }),
        mission.id,
      );
      expect(zero.status).toBe(422);
      expect(await zero.json()).toMatchObject({
        error: 'refused',
        issues: [{ code: 'invalid-budget' }],
      });
      const foreign = await handler().setLimits(
        limitsRequest(
          await sessionHeaders(rig.root, rig.seeded.ada, { origin: 'https://evil.example' }),
          edit,
        ),
        mission.id,
      );
      expect(foreign.status).toBe(403);

      await service().revoke(rig.seeded.ada, mission.id);
      const closed = await handler().setLimits(
        limitsRequest(await sessionHeaders(rig.root, rig.seeded.ada), edit),
        mission.id,
      );
      expect(closed.status).toBe(409);
      expect(await entryOf(READ)).toMatchObject({ quota: 5 });
    });
  });
});
