/**
 * The gate of an accepted risk, edited after issuance (spec §3.5: "the creator sets
 * the risk's gate to `approval` at issuance, or later"; §4.2 "Mission session — gate
 * per risk"). Over the real composition root: the mission service, its HTTP handler
 * and the budget the execution door decides with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { budgetMissionOf } from '../../../src/server/budget';
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

describe('editing a gate after issuance', () => {
  let rig: OperatorRig;
  /** READ and PR `auto`, MERGE `approval` (the audit rig's daily GitHub mission). */
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    mission = await issueMission(rig);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const service = () => rig.root.missions.service;
  const fresh = async (): Promise<MissionRecord> => {
    const record = await rig.root.store.missions.getById(mission.id);
    if (!record) throw new Error('the mission vanished');
    return record;
  };
  const gateOf = async (riskId: string) =>
    (await fresh()).policy.find((entry) => entry.riskId === riskId)?.gate;
  /** One call as the door records it, on the mission as it is stored now. */
  const call = async (riskId: string, args: Record<string, unknown> = { n: 1 }) =>
    (await seedCall(rig, await fresh(), { tool: 'github__tool', risks: [riskId], args })).result;
  const gateEdits = async () =>
    (await rig.root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.act === 'gate-changed' ? [e] : [],
    );
  const events = async () => {
    const session = await rig.root.store.sessions.getByMission(mission.id);
    return session ? rig.root.store.sessions.listEvents(session.id) : [];
  };

  function gateRequest(headers: Headers, body: unknown, id = mission.id): Request {
    return new Request(`${PUBLIC_URL}/api/missions/${id}/gate`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('auto → approval: the next call on the risk asks the creator; the rest of the policy is untouched', async () => {
    expect((await call(READ)).outcome).toBe('allowed');
    const before = await fresh();

    const result = await service().setGate(rig.seeded.ada, mission.id, READ, 'approval');
    expect(result).toMatchObject({ ok: true, risk_id: READ, gate: 'approval', previous: 'auto' });

    const after = await fresh();
    expect(after.policy).toEqual(
      before.policy.map((entry) =>
        entry.riskId === READ ? { ...entry, gate: 'approval' } : entry,
      ),
    );
    expect(after.connections).toEqual(before.connections);
    expect(after.status).toBe('active');

    const refused = await call(READ, { n: 2 });
    expect(refused).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'approval-required', risk_id: READ },
    });
    // The other risks keep their gate.
    expect((await call(PR)).outcome).toBe('allowed');
  });

  it('approval → auto: calls pass without asking; the open request is left where it is', async () => {
    const asked = await call(MERGE);
    if (asked.outcome !== 'refused' || !asked.request_id) throw new Error('expected a request');

    const result = await service().setGate(rig.seeded.ada, mission.id, MERGE, 'auto');
    expect(result).toMatchObject({ ok: true, gate: 'auto', previous: 'approval' });
    expect(await call(MERGE)).toMatchObject({ outcome: 'allowed', approval_ids: [] });

    // The request is still open in the inbox: the creator closes it, or it expires.
    expect((await rig.root.store.requests.getById(asked.request_id))?.state).toBe('open');
    const view = await rig.root.requests.service.view(rig.seeded.ada, asked.request_id);
    if (view.outcome !== 'ok' || view.view.kind !== 'approval') throw new Error('expected a view');
    expect(view.view.gate).toEqual({ policy: 'auto', open_until: null });
    expect(view.view.options.find((o) => o.resolution === 'open-gate')?.unavailable?.code).toBe(
      'gate-not-closed',
    );
  });

  it('writes one administrative entry with the gate before and after, and a session event', async () => {
    // Before the first call there is no session: the entry is written, no event.
    await service().setGate(rig.seeded.ada, mission.id, PR, 'approval');
    expect(await gateEdits()).toMatchObject([
      {
        user_id: rig.seeded.ada.id,
        object: { type: 'mission', id: mission.id },
        before: { risk_id: PR, gate: 'auto' },
        after: { risk_id: PR, gate: 'approval' },
        delegated_client_id: null,
      },
    ]);
    expect(await events()).toEqual([]);

    // Once the session exists, the edit is on its timeline too.
    await call(READ);
    await service().setGate(rig.seeded.ada, mission.id, PR, 'auto');
    expect(await gateEdits()).toHaveLength(2);
    expect((await events()).at(-1)).toMatchObject({
      kind: 'gate-changed',
      riskId: PR,
      actorUserId: rig.seeded.ada.id,
      details: { gate: 'auto', gate_before: 'approval' },
    });
  });

  it('setting the gate a risk already has changes nothing and records nothing', async () => {
    await call(READ);
    const updatedAt = (await fresh()).updatedAt;
    const result = await service().setGate(rig.seeded.ada, mission.id, MERGE, 'approval');
    expect(result).toMatchObject({ ok: true, gate: 'approval', previous: 'approval' });
    expect(await gateEdits()).toEqual([]);
    expect((await events()).map((e) => e.kind)).not.toContain('gate-changed');
    expect((await fresh()).updatedAt).toBe(updatedAt);
  });

  it('only the creator edits: an operator and another user get the answer of an unknown mission', async () => {
    for (const user of [rig.operator, rig.seeded.bob]) {
      expect(await service().setGate(user, mission.id, MERGE, 'auto')).toEqual({
        ok: false,
        reason: 'not-found',
      });
    }
    expect(await service().setGate(rig.seeded.ada, 'no-such-mission', MERGE, 'auto')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await gateOf(MERGE)).toBe('approval');
    expect(await gateEdits()).toEqual([]);
  });

  it('refuses a value that is not a gate, a risk outside the policy, a closed mission', async () => {
    expect(await service().setGate(rig.seeded.ada, mission.id, MERGE, 'sometimes')).toEqual({
      ok: false,
      reason: 'invalid-gate',
    });
    // An accepted risk only: a gate edit never adds a risk to the mission.
    expect(
      await service().setGate(rig.seeded.ada, mission.id, 'github.bulk-file-write', 'approval'),
    ).toEqual({ ok: false, reason: 'risk-not-in-policy' });
    expect((await fresh()).policy.map((entry) => entry.riskId).sort()).toEqual(
      [MERGE, PR, READ].sort(),
    );

    await service().revoke(rig.seeded.ada, mission.id);
    expect(await service().setGate(rig.seeded.ada, mission.id, MERGE, 'auto')).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'revoked',
    });
    expect(await gateOf(MERGE)).toBe('approval');
    expect(await gateEdits()).toEqual([]);
  });

  it('"ask me again" on an EXPIRED mission closes the opening too: it must not be found open when the expiry is extended', async () => {
    // The creator opened MERGE for the period while the mission was alive.
    const asked = await call(MERGE);
    if (asked.outcome !== 'refused' || !asked.request_id) throw new Error('expected a request');
    await rig.root.requests.service.decide(rig.seeded.ada, asked.request_id, {
      resolution: 'open-gate',
    });
    expect((await call(MERGE, { n: 2 })).outcome).toBe('allowed');

    // The expiry passes. The stored gate still reads `approval`, the opening still stands.
    await rig.root.store.missions.setExpiresAt(mission.id, '2020-01-01T00:00:00.000Z');
    const detail = await service().get(rig.seeded.ada, mission.id);
    expect(detail?.state.kind).toBe('expired');
    // An expired mission comes back when its expiry is extended: its gates stay editable.
    expect(detail?.gates_editable).toBe(true);

    const result = await service().setGate(rig.seeded.ada, mission.id, MERGE, 'approval');

    expect(result).toMatchObject({ ok: true, previous: 'approval', opening_closed: true });
    expect(await gateEdits()).toHaveLength(1);
    expect((await gateEdits())[0]).toMatchObject({
      before: { risk_id: MERGE, gate: 'approval', open_for_period: true },
      after: { risk_id: MERGE, gate: 'approval', open_for_period: false },
    });

    // The creator extends the expiry, in the same period: the next call asks again.
    await rig.root.store.missions.setExpiresAt(mission.id, null);
    const after = await call(MERGE, { n: 3 });
    // Refused with a new approval request: the gate asks again.
    expect(after.outcome).toBe('refused');
    expect(after.outcome === 'refused' && after.request_id).toBeTruthy();
  });

  it('on an expired mission with no opening, a repeated `approval` writes nothing', async () => {
    await rig.root.store.missions.setExpiresAt(mission.id, '2020-01-01T00:00:00.000Z');
    const result = await service().setGate(rig.seeded.ada, mission.id, MERGE, 'approval');
    expect(result).toMatchObject({ ok: true, previous: 'approval', opening_closed: false });
    expect(await gateEdits()).toEqual([]);
  });

  it('asking for `approval` on a risk whose gate is open for the period closes the opening: one entry, one event', async () => {
    const asked = await call(MERGE);
    if (asked.outcome !== 'refused' || !asked.request_id) throw new Error('expected a request');
    await rig.root.requests.service.decide(rig.seeded.ada, asked.request_id, {
      resolution: 'open-gate',
    });
    expect((await call(MERGE, { n: 2 })).outcome).toBe('allowed');

    // The stored gate is already `approval`: the answer used to be 200 with the opening left.
    const result = await service().setGate(rig.seeded.ada, mission.id, MERGE, 'approval');
    expect(result).toMatchObject({
      ok: true,
      gate: 'approval',
      previous: 'approval',
      opening_closed: true,
    });
    expect(await call(MERGE, { n: 3 })).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'approval-required' },
    });
    const detail = await service().get(rig.seeded.ada, mission.id);
    expect(detail?.policy.find((r) => r.risk_id === MERGE)?.gate_open_until).toBeNull();
    expect(await gateEdits()).toMatchObject([
      {
        user_id: rig.seeded.ada.id,
        before: { risk_id: MERGE, gate: 'approval', open_for_period: true },
        after: { risk_id: MERGE, gate: 'approval', open_for_period: false },
      },
    ]);
    expect((await events()).filter((e) => e.kind === 'gate-changed')).toHaveLength(1);

    // Asked again, there is nothing left to close: nothing is written.
    const again = await service().setGate(rig.seeded.ada, mission.id, MERGE, 'approval');
    expect(again).toMatchObject({ ok: true, opening_closed: false });
    expect(await gateEdits()).toHaveLength(1);
  });

  it('the mission detail shows the gate, and until when an opening holds', async () => {
    const asked = await call(MERGE);
    if (asked.outcome !== 'refused' || !asked.request_id) throw new Error('expected a request');
    const detailBefore = await service().get(rig.seeded.ada, mission.id);
    expect(detailBefore?.policy.find((r) => r.risk_id === MERGE)).toMatchObject({
      gate: 'approval',
      gate_open_until: null,
    });

    await rig.root.requests.service.decide(rig.seeded.ada, asked.request_id, {
      resolution: 'open-gate',
    });
    const opened = await service().get(rig.seeded.ada, mission.id);
    const state = opened?.state;
    if (state?.kind !== 'active') throw new Error('expected an active mission');
    expect(opened?.policy.find((r) => r.risk_id === MERGE)).toMatchObject({
      gate: 'approval',
      gate_open_until: state.period.end,
    });
    expect(opened?.policy.find((r) => r.risk_id === READ)?.gate_open_until).toBeNull();
    expect((await call(MERGE, { n: 2 })).outcome).toBe('allowed');

    // The creator sets the gate back on the mission: the opening ends at once, even
    // when the edit lands in the same millisecond as the opening.
    await service().setGate(rig.seeded.ada, mission.id, MERGE, 'auto');
    await service().setGate(rig.seeded.ada, mission.id, MERGE, 'approval');
    const closed = await service().get(rig.seeded.ada, mission.id);
    expect(closed?.policy.find((r) => r.risk_id === MERGE)).toMatchObject({
      gate: 'approval',
      gate_open_until: null,
    });
    expect(await call(MERGE, { n: 3 })).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'approval-required' },
    });
  });

  it('the budget decides with the mission as stored: the edit needs no restart and no re-issue', async () => {
    const token = (await service().rotate(rig.seeded.ada, mission.id)) as { ok: true };
    expect(token.ok).toBe(true);
    await service().setGate(rig.seeded.ada, mission.id, READ, 'approval');
    const decided = await rig.root.budget.recordCall({
      mission: budgetMissionOf(await fresh()),
      tool: 'github__get_file',
      args: { path: 'README.md' },
      risks_touched: [READ],
      now: new Date(),
    });
    expect(decided).toMatchObject({ outcome: 'refused', refusal: { code: 'approval-required' } });
  });

  describe('POST /api/missions/:id/gate', () => {
    const handler = () => rig.root.missions.handlers;

    it('200 for the creator, with the gate before and after', async () => {
      const response = await handler().setGate(
        gateRequest(await sessionHeaders(rig.root, rig.seeded.ada), {
          risk_id: READ,
          gate: 'approval',
        }),
        mission.id,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        mission: { id: mission.id },
        risk_id: READ,
        gate: 'approval',
        previous: 'auto',
        opening_closed: false,
      });
      expect(await gateOf(READ)).toBe('approval');
    });

    it.each([
      ['not JSON', '{'],
      ['no risk', { gate: 'auto' }],
      ['no gate', { risk_id: READ }],
      ['a value that is not a gate', { risk_id: READ, gate: 'open' }],
      ['an unexpected field', { risk_id: READ, gate: 'approval', quota: 9999 }],
      ['a list', [{ risk_id: READ, gate: 'approval' }]],
    ])('400 for %s', async (_what, body) => {
      const response = await handler().setGate(
        gateRequest(await sessionHeaders(rig.root, rig.seeded.ada), body),
        mission.id,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid-gate-edit' });
      expect(await gateOf(READ)).toBe('auto');
    });

    it('404 for anyone else, 422 for a risk outside the policy, 409 for a closed mission', async () => {
      const edit = { risk_id: MERGE, gate: 'auto' };
      for (const user of [rig.operator, rig.seeded.bob]) {
        const response = await handler().setGate(
          gateRequest(await sessionHeaders(rig.root, user), edit),
          mission.id,
        );
        expect(response.status).toBe(404);
      }
      const outside = await handler().setGate(
        gateRequest(await sessionHeaders(rig.root, rig.seeded.ada), {
          risk_id: 'github.bulk-file-write',
          gate: 'approval',
        }),
        mission.id,
      );
      expect(outside.status).toBe(422);
      expect(await outside.json()).toMatchObject({ error: 'risk-not-in-policy' });

      await service().revoke(rig.seeded.ada, mission.id);
      const closed = await handler().setGate(
        gateRequest(await sessionHeaders(rig.root, rig.seeded.ada), edit),
        mission.id,
      );
      expect(closed.status).toBe(409);
      expect(await closed.json()).toMatchObject({ error: 'mission-inactive' });
      expect(await gateOf(MERGE)).toBe('approval');
    });

    it('403 from another origin and for the bootstrap operator; 401 with no session', async () => {
      const edit = { risk_id: MERGE, gate: 'auto' };
      const foreign = await handler().setGate(
        gateRequest(
          await sessionHeaders(rig.root, rig.seeded.ada, { origin: 'https://evil.example' }),
          edit,
        ),
        mission.id,
      );
      expect(foreign.status).toBe(403);

      const bootstrap = await rig.root.auth.sessions.create({ kind: 'bootstrap' });
      const asBootstrap = await handler().setGate(
        gateRequest(
          new Headers({
            cookie: `${SESSION_COOKIE}=${bootstrap.id}`,
            origin: PUBLIC_URL,
            'content-type': 'application/json',
          }),
          edit,
        ),
        mission.id,
      );
      expect(asBootstrap.status).toBe(403);

      const anonymous = await handler().setGate(
        gateRequest(new Headers({ origin: PUBLIC_URL, 'content-type': 'application/json' }), edit),
        mission.id,
      );
      expect(anonymous.status).toBe(401);
      expect(await gateOf(MERGE)).toBe('approval');
    });
  });
});
