import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
  type RpcBody,
} from '../../support/execution/testing';
import { budgetMissionOf } from '../../../src/server/budget';
import { sessionHeaders } from './support';
import type { MissionPolicyEntry } from '@vaubaan/shared';

const TOOL = 'vaubaan__request_permission';
const READ = 'depot.read';
const WRITE = 'depot[staging].write';
function answer(body: RpcBody): Record<string, unknown> {
  const content = body.result?.content as { text: string }[] | undefined;
  if (!content?.[0]) throw new Error(JSON.stringify(body));
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

/** What a line of `risk` consumed: these missions have one set. */
function consumedOn(consumed: ReadonlyMap<string, number>, risk: string): number | undefined {
  return [...consumed].find(([line]) => line.endsWith(`::${risk}`))?.[1];
}

describe('creator permission edits and deliberate agent requests', () => {
  let rig: ExecutionInstance;
  let mission: IssuedMission;
  beforeEach(async () => {
    rig = await executionInstance();
    mission = await rig.issue({ policy: [line(READ, 3)], spaces: ['app-staging'] });
  });
  afterEach(async () => {
    await rig.close();
  });
  async function policy() {
    const stored = await rig.root.store.missions.getById(mission.mission.id);
    if (!stored) throw new Error('missing mission');
    return budgetMissionOf(stored).policy;
  }
  async function edit(next: readonly MissionPolicyEntry[], requestId?: string) {
    return rig.root.missions.service.changePermissions(rig.ada, mission.mission.id, {
      policy: next,
      expected_policy: await policy(),
      ...(requestId ? { request_id: requestId } : {}),
    });
  }
  async function refusal() {
    const body = await rig.call(mission, 'depot__write_item', { space: 'app-staging' });
    expect(body.error?.data?.code).toBe('risk-not-accepted');
    expect(body.error?.data?.refusal_id).toEqual(expect.any(String));
    return String(body.error?.data?.refusal_id);
  }
  async function ask(refusalId: string) {
    return answer(
      await rig.call(mission, TOOL, {
        refusal_id: refusalId,
        reason: 'The assigned migration needs to write an item.',
      }),
    );
  }
  it('refuses without opening an inbox item; asking explicitly creates one and never executes', async () => {
    const id = await refusal();
    expect(await rig.root.requests.service.inbox(rig.ada)).toEqual([]);
    expect(rig.depot.calls).toHaveLength(0);
    const asked = await ask(id);
    expect(asked.state).toBe('open');
    expect(String(asked.request_url)).toContain('/r/');
    expect(await rig.root.requests.service.inbox(rig.ada)).toMatchObject([
      { kind: 'permission', risks: [{ risk_id: WRITE }] },
    ]);
    const view = await rig.root.requests.service.view(rig.ada, String(asked.request_id));
    expect(view).toMatchObject({
      outcome: 'ok',
      view: {
        kind: 'permission',
        reason: 'The assigned migration needs to write an item.',
        asker: { user_id: rig.ada.id },
      },
    });
    expect(rig.depot.calls).toHaveLength(0);
  });
  it('deduplicates the reference and fresh refusals for the same holder and permission set', async () => {
    const id = await refusal();
    const first = await ask(id);
    expect((await ask(id)).request_id).toBe(first.request_id);
    expect((await ask(await refusal())).request_id).toBe(first.request_id);
    expect(await rig.root.requests.service.openCount(rig.ada)).toBe(1);
  });
  it('audits every request-tool call, including duplicates and invalid input, without storing the reason', async () => {
    const ref = await refusal();
    await ask(ref);
    await ask(ref);
    await rig.call(mission, TOOL, { refusal_id: ref, reason: '' });
    const entries = (await rig.root.store.audit.list({ kind: 'call' })).filter(
      (entry) => entry.kind === 'call' && entry.tool === TOOL,
    );
    expect(entries).toHaveLength(3);
    expect(
      entries.filter((entry) => entry.kind === 'call' && entry.decision === 'allowed'),
    ).toHaveLength(2);
    expect(
      entries.filter((entry) => entry.kind === 'call' && entry.decision === 'refused'),
    ).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('The assigned migration');
  });
  it('adds requested permissions with the same key and preserves existing consumption', async () => {
    await rig.call(mission, 'depot__read_item', { space: 'app-staging' });
    const asked = await ask(await refusal());
    expect(
      await edit([...(await policy()), line(WRITE, 2)], String(asked.request_id)),
    ).toMatchObject({ ok: true });
    expect(await rig.root.requests.service.openCount(rig.ada)).toBe(0);
    expect(
      (await rig.call(mission, 'depot__write_item', { space: 'app-staging' })).error,
    ).toBeUndefined();
    const stored = await rig.root.store.missions.getById(mission.mission.id);
    const usage = await rig.root.budget.usageOf(budgetMissionOf(stored!), new Date());
    expect(consumedOn(usage.consumed, READ)).toBe(1);
    expect(consumedOn(usage.consumed, WRITE)).toBe(1);
    const audit = await rig.root.store.audit.list({ kind: 'admin' });
    expect(audit.some((e) => e.kind === 'admin' && e.act === 'permissions-changed')).toBe(true);
  });
  it('keeps consumed quota across removal and re-addition', async () => {
    await rig.call(mission, 'depot__read_item', { space: 'app-staging' });
    const original = await policy();
    expect(await edit([])).toMatchObject({ ok: true });
    expect(
      (await rig.call(mission, 'depot__read_item', { space: 'app-staging' })).error,
    ).toBeDefined();
    expect(await edit(original)).toMatchObject({ ok: true });
    const stored = await rig.root.store.missions.getById(mission.mission.id);
    const usage = await rig.root.budget.usageOf(budgetMissionOf(stored!), new Date());
    expect(consumedOn(usage.consumed, READ)).toBe(1);
  });
  it('retires an unused one-call approval when its permission is removed', async () => {
    const gated = [...(await policy()), line(WRITE, 2, { gate: 'approval' })];
    await edit(gated);
    const refused = await rig.call(mission, 'depot__write_item', { space: 'app-staging' });
    expect(refused.error?.data?.code).toBe('approval-required');
    const id = String(refused.error?.data?.approval_url).split('/').at(-1)!;
    expect(
      await rig.root.requests.service.decide(rig.ada, id, { resolution: 'grant' }),
    ).toMatchObject({ ok: true });
    expect(await rig.root.store.approvals.listActive(mission.mission.id)).toHaveLength(1);
    await edit([line(READ, 3)]);
    await edit(gated);
    expect(await rig.root.store.approvals.listActive(mission.mission.id)).toHaveLength(0);
    expect(
      (await rig.call(mission, 'depot__write_item', { space: 'app-staging' })).error?.data?.code,
    ).toBe('approval-required');
    expect(rig.depot.calls).toHaveLength(0);
  });
  it('checks the creator’s current share before adding a permission', async () => {
    const bob = await rig.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'limited-creator',
      email: 'limited@example.com',
    });
    const share = (riskIds: readonly string[]) =>
      rig.root.shares.service.share({ user: rig.ada, groups: [] }, rig.account.id, {
        target: { kind: 'user', email: bob.email },
        riskIds,
      });
    await share([READ, WRITE]);
    const issued = await rig.root.missions.service.issue(bob, {
      name: 'Limited creator',
      accounts: [
        {
          account_id: rig.account.id,
          resources: { scope: 'selected', resource_refs: ['app-staging'] },
          policy: [line(READ, 3)],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(JSON.stringify(issued));
    await share([READ]);
    expect(
      await rig.root.missions.service.changePermissions(bob, issued.mission.id, {
        expected_policy: [line(READ, 3)],
        policy: [line(READ, 3), line(WRITE)],
      }),
    ).toMatchObject({ ok: false, reason: 'refused', issues: [{ code: 'exceeds-authority' }] });
    expect(
      (await rig.root.store.missions.getById(issued.mission.id))?.policy.map((p) => p.riskId),
    ).toEqual([READ]);
  });
  it('refuses a stale edit instead of overwriting a concurrent change', async () => {
    const old = await policy();
    await rig.root.missions.service.setLimits(rig.ada, mission.mission.id, [
      { risk_id: READ, quota: 5, rate_limit_max: 1000 },
    ]);
    expect(
      await rig.root.missions.service.changePermissions(rig.ada, mission.mission.id, {
        expected_policy: old,
        policy: [...old, line(WRITE)],
      }),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await policy()).find((p) => p.risk_id === READ)?.quota).toBe(5);
  });
  it('refuses additions outside the catalog or mission resources, and unknown body fields', async () => {
    expect(await edit([...(await policy()), line('depot[prod].write')])).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(await edit([...(await policy()), line('depot.invented')])).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(
      await rig.root.missions.service.changePermissions(rig.ada, mission.mission.id, {
        policy: [],
        expected_policy: await policy(),
        resources: ['other'],
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-edit' });
  });
  it('only the creator may edit or read and refuse the request', async () => {
    const other = await rig.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'bob',
      email: 'bob@example.com',
    });
    const asked = await ask(await refusal());
    const id = String(asked.request_id);
    expect(await rig.root.requests.service.view(other, id)).toEqual({ outcome: 'forbidden' });
    expect(
      await rig.root.requests.service.decide(other, id, { resolution: 'refuse' }),
    ).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(
      await rig.root.missions.service.changePermissions(other, mission.mission.id, {
        policy: [],
        expected_policy: await policy(),
      }),
    ).toMatchObject({ ok: false, reason: 'not-found' });
    expect(
      await rig.root.requests.service.decide(rig.ada, id, { resolution: 'refuse' }),
    ).toMatchObject({ ok: true });
    expect(await edit([...(await policy()), line(WRITE)], id)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect((await policy()).map((p) => p.risk_id)).not.toContain(WRITE);
  });
  it('returns a closed answer when the same reference is reused', async () => {
    const ref = await refusal();
    const asked = await ask(ref);
    await rig.root.requests.service.decide(rig.ada, String(asked.request_id), {
      resolution: 'refuse',
    });
    expect(await ask(ref)).toMatchObject({ request_id: asked.request_id, state: 'refused' });
    expect(await rig.root.requests.service.openCount(rig.ada)).toBe(0);
  });
  it('rejects forged, expired and another mission’s references and empty reasons', async () => {
    expect(await ask('invented')).toMatchObject({ error: 'invalid-refusal' });
    const ref = await refusal();
    const other = await rig.issue({ policy: [line(READ)] });
    expect(
      answer(await rig.call(other, TOOL, { refusal_id: ref, reason: 'Need it' })),
    ).toMatchObject({ error: 'invalid-refusal' });
    expect(answer(await rig.call(mission, TOOL, { refusal_id: ref, reason: '   ' }))).toMatchObject(
      { error: 'invalid-request' },
    );
    rig.root.store.db
      .prepare('UPDATE permission_refusals SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', ref);
    expect(await ask(ref)).toMatchObject({ error: 'invalid-refusal' });
  });
  it('caps new requests at ten per rolling day, while repeated references remain readable', async () => {
    let lastRef = '';
    for (let i = 0; i < 10; i++) {
      lastRef = await refusal();
      const asked = await ask(lastRef);
      await rig.root.requests.service.decide(rig.ada, String(asked.request_id), {
        resolution: 'refuse',
      });
    }
    expect(await ask(await refusal())).toMatchObject({ error: 'rate-limited' });
    expect(await ask(lastRef)).toMatchObject({ state: 'refused' });
  });
  it('checks the human session and origin on the edit route', async () => {
    const body = JSON.stringify({
      policy: [...(await policy()), line(WRITE)],
      expected_policy: await policy(),
    });
    const send = (headers: HeadersInit) =>
      rig.root.missions.handlers.changePermissions(
        new Request('https://gateway.example.com/api/missions/x/permissions', {
          method: 'POST',
          headers,
          body,
        }),
        mission.mission.id,
      );
    expect(
      (await send({ authorization: `Bearer ${mission.token}`, 'content-type': 'application/json' }))
        .status,
    ).toBe(403);
    const headers = await sessionHeaders(rig.root, rig.ada);
    headers.set('origin', 'https://evil.example');
    expect((await send(headers)).status).toBe(403);
    headers.set('origin', 'https://gateway.example.com');
    expect((await send(headers)).status).toBe(200);
  });
  it('binds a refusal to its token, even when another key belongs to the same mission', async () => {
    const ref = await refusal();
    const other = await rig.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'member',
      email: 'member@example.com',
    });
    await rig.root.store.missions.addMember({
      missionId: mission.mission.id,
      userId: other.id,
      addedBy: rig.ada.id,
    });
    const token = await rig.root.missions.team.generateToken(other, mission.mission.id);
    if (!token.ok) throw new Error(JSON.stringify(token));
    const held = { ...mission, token: token.token.secret };
    expect(
      answer(await rig.call(held, TOOL, { refusal_id: ref, reason: 'Need it' })),
    ).toMatchObject({ error: 'invalid-refusal' });
  });
  it('deduplicates simultaneous requests and grants a request at most once', async () => {
    const ref = await refusal();
    const asked = await Promise.all([ask(ref), ask(ref), ask(ref)]);
    expect(new Set(asked.map((a) => a.request_id)).size).toBe(1);
    const id = String(asked[0]?.request_id);
    const current = await policy();
    const input = { expected_policy: current, policy: [...current, line(WRITE)], request_id: id };
    const changes = await Promise.all(
      [1, 2].map(() =>
        rig.root.missions.service.changePermissions(rig.ada, mission.mission.id, input),
      ),
    );
    expect(changes.filter((c) => c.ok)).toHaveLength(1);
  });
  it('does not grant an expired request or let it change the mission', async () => {
    const asked = await ask(await refusal());
    const id = String(asked.request_id);
    rig.root.store.db
      .prepare('UPDATE requests SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', id);
    expect(await edit([...(await policy()), line(WRITE)], id)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect((await policy()).map((p) => p.risk_id)).not.toContain(WRITE);
    await rig.root.requests.service.sweep();
    expect(await rig.root.store.requests.getById(id)).toMatchObject({ state: 'expired' });
  });
  it('refuses a removed permission even when a call carries the earlier admitted policy', async () => {
    const old = budgetMissionOf(mission.mission);
    await edit([]);
    await expect(
      rig.root.budget.recordCall({
        mission: old,
        tool: 'depot__read_item',
        args: {},
        risks_touched: [READ],
        now: new Date(),
      }),
    ).rejects.toThrow('absent from the mission policy');
    expect(rig.depot.calls).toHaveLength(0);
  });
  it('reads a stricter gate after removal and re-addition before a stale call decides', async () => {
    const old = budgetMissionOf(mission.mission);
    await edit([]);
    await edit([line(READ, 3, { gate: 'approval' })]);
    expect(
      await rig.root.budget.recordCall({
        mission: old,
        tool: 'depot__read_item',
        args: { space: 'app-staging' },
        risks_touched: [READ],
        now: new Date(),
      }),
    ).toMatchObject({ outcome: 'refused', refusal: { code: 'approval-required' } });
  });
  it('does not resurrect stopped or orphaned missions', async () => {
    await rig.root.store.accounts.revoke(rig.account.id);
    expect(await edit([...(await policy()), line(WRITE)])).toMatchObject({
      ok: false,
      reason: 'inactive',
      state: 'orphaned',
    });
    await rig.root.store.missions.setStatus(mission.mission.id, 'revoked');
    expect(await edit([...(await policy()), line(WRITE)])).toMatchObject({
      ok: false,
      reason: 'inactive',
    });
  });
});
