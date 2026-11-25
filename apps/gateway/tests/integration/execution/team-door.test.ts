/**
 * The execution door with several holders on one mission, over HTTP (spec §0
 * "Mission token", §3.2 "one budget per mission, however many agents or
 * tokens", §7.9 bis, §8 "the token used and its holder"; ADR
 * mission-members-and-per-holder-tokens).
 *
 *   - two members and a named token draw from ONE counter and are attributed
 *     separately, in the audit, the mission log and the catalog;
 *   - the holder is the token's, whatever the caller declares;
 *   - a token whose member was removed or deactivated, or that was rotated or
 *     revoked on its own, is refused 401 with the reason at the very next call
 *     while the others keep working;
 *   - the mission's own state still rules every holder: revoked or orphaned is
 *     `mission-inactive` for all of them.
 */
import { AUTH_FAILURE_MESSAGES, AUTH_REQUIRED_RPC_CODE } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MissionCatalog } from '../../../src/server/execution';
import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
  type RpcBody,
} from '../../support/execution/testing';
import type { UserRecord } from '../../../src/server/store/types';

const READ = 'depot.read';
const TOOL = 'depot__read_item';
const ARGS = { space: 'scratch', item: 'readme' };
const QUOTA = 5;

describe('execution door: one mission, several token holders', () => {
  let instance: ExecutionInstance;
  let ada: UserRecord;
  let bob: UserRecord;
  let mission: IssuedMission;
  /** Bearers: Ada's (the creator), Bob's (a member), the CI runner's (a named token). */
  let adaToken: string;
  let bobToken: string;
  let ciToken: string;

  beforeEach(async () => {
    instance = await executionInstance();
    ({ ada } = instance);
    bob = await instance.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob',
      email: 'bob@example.com',
    });
    mission = await instance.issue({
      policy: [line(READ, QUOTA)],
      spaces: ['scratch'],
      name: 'Team mission',
    });
    adaToken = mission.token;
    const { team } = instance.root.missions;
    const added = await team.addMember(ada, mission.mission.id, { email: bob.email });
    if (!added.ok) throw new Error(`add refused: ${added.reason}`);
    bobToken = await generate(bob);
    const named = await team.createNamedToken(ada, mission.mission.id, 'CI runner');
    if (!named.ok) throw new Error(`named token refused: ${named.reason}`);
    ciToken = named.token.secret;
  });
  afterEach(async () => {
    await instance.close();
  });

  async function generate(user: UserRecord): Promise<string> {
    const generated = await instance.root.missions.team.generateToken(user, mission.mission.id);
    if (!generated.ok) throw new Error(`generate refused: ${generated.reason}`);
    return generated.token.secret;
  }

  let nextId = 1;
  function call(token: string, headers: Record<string, string> = {}, meta?: object) {
    return instance.rpc(
      token,
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: TOOL, arguments: ARGS, ...(meta ? { _meta: meta } : {}) },
      },
      headers,
    );
  }

  const allowed = (body: RpcBody) => body.error === undefined && body.result !== undefined;

  /** The token authenticates and its mission serves: `tools/list` answers (no credit is spent). */
  async function serves(token: string): Promise<boolean> {
    const answer = await instance.rpc(token, {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
    });
    return answer.status === 200 && allowed(answer.body);
  }

  async function catalog(token: string): Promise<{ status: number; body: MissionCatalog }> {
    const response = await instance.root.execution.handlers.catalog(
      new Request(`${TEST_PUBLIC_URL}/mcp/catalog`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    return { status: response.status, body: (await response.json()) as MissionCatalog };
  }

  const callEntries = async () =>
    (await instance.root.store.audit.list({ missionId: mission.mission.id, kind: 'call' })).flatMap(
      (e) => (e.kind === 'call' ? [e] : []),
    );

  const consumed = async (): Promise<number> => {
    const missionLog = await instance.root.store.missionLogs.getByMission(mission.mission.id);
    if (!missionLog) return 0;
    const counters = await instance.root.store.missionLogs.counters(missionLog.id);
    return counters.filter((c) => c.riskId === READ).reduce((sum, c) => sum + c.consumed, 0);
  };

  /** The 401 of a token that authenticated before and no longer does. */
  function expectStopped(
    answer: { status: number; headers: Headers; body: RpcBody },
    reason: keyof typeof AUTH_FAILURE_MESSAGES,
  ): void {
    expect(answer.status).toBe(401);
    expect(answer.headers.get('www-authenticate')).toContain('Bearer');
    expect(answer.body.error).toEqual({
      code: AUTH_REQUIRED_RPC_CODE,
      message: AUTH_FAILURE_MESSAGES[reason],
      data: { reason },
    });
  }

  // ── One budget, attributed per holder ─────────────────────────────────────

  it('two members and a named token share one counter and are attributed separately', async () => {
    for (const token of [adaToken, bobToken, ciToken, bobToken, adaToken]) {
      expect(allowed((await call(token)).body)).toBe(true);
    }
    // Five calls by three holders spent the five credits of the ONE budget...
    expect(await consumed()).toBe(QUOTA);
    // ...so the sixth is refused whoever makes it: a token does not come with a budget.
    for (const token of [ciToken, bobToken, adaToken]) {
      const refused = await call(token);
      expect(refused.status).toBe(200);
      expect(refused.body.error?.data).toMatchObject({
        code: 'budget-exhausted',
        risk_id: READ,
        quota: QUOTA,
        consumed: QUOTA,
      });
    }
    expect(await consumed()).toBe(QUOTA);

    // The audit names the token used and its holder on every entry, refused ones included.
    const entries = await callEntries();
    expect(entries.map((e) => [e.token_kind, e.token_holder, e.decision])).toEqual([
      ['member', ada.id, 'allowed'],
      ['member', bob.id, 'allowed'],
      ['named', 'CI runner', 'allowed'],
      ['member', bob.id, 'allowed'],
      ['member', ada.id, 'allowed'],
      ['named', 'CI runner', 'refused'],
      ['member', bob.id, 'refused'],
      ['member', ada.id, 'refused'],
    ]);
    const tokens = await instance.root.store.missions.listTokens(mission.mission.id);
    const idOf = (holder: string) =>
      tokens.find((t) => (t.holder.kind === 'member' ? t.holder.userId : t.holder.name) === holder)
        ?.id;
    expect(entries.map((e) => e.token_id)).toEqual(
      [ada.id, bob.id, 'CI runner', bob.id, ada.id, 'CI runner', bob.id, ada.id].map(idOf),
    );

    // The mission log: the same attribution on the events, and the per-holder table.
    const view = await instance.root.audit.missionLogs.get(ada, mission.mission.id);
    expect(view?.holder_activity.map((a) => [a.holder?.label, a.allowed, a.refused])).toEqual([
      [ada.email, 2, 1],
      [bob.email, 2, 1],
      ['CI runner', 1, 1],
    ]);
    const calls = view?.events.filter((e) => e.kind.startsWith('call-')) ?? [];
    expect(calls.map((e) => e.holder?.label).reverse()).toEqual([
      ada.email,
      bob.email,
      'CI runner',
      bob.email,
      ada.email,
      'CI runner',
      bob.email,
      ada.email,
    ]);
    // The per-holder counts are not a budget: the budget line is the mission's.
    expect(view?.risks.find((r) => r.risk_id === READ)).toMatchObject({
      quota: QUOTA,
      consumed: QUOTA,
      remaining: 0,
      exhausted: true,
    });

    // The timeline of one holder, and the audit search by holder.
    const bobs = await instance.root.audit.timeline.search(
      { kind: 'user', user: ada, groups: [], isOperator: false },
      {
        missionId: mission.mission.id,
        holder: `member:${bob.id}`,
        agentLabel: null,
        unlabelled: false,
      },
    );
    expect(bobs.events.map((e) => [e.kind, e.holder?.label])).toEqual([
      ['call-refused', bob.email],
      ['call-allowed', bob.email],
      ['call-allowed', bob.email],
    ]);
    const viewer = { kind: 'user', user: ada, groups: [], isOperator: false } as const;
    const NONE = {
      missionId: null,
      user: null,
      accountId: null,
      tool: null,
      decision: null,
      agentLabel: null,
      tokenHolder: null,
      kind: null,
      since: null,
      until: null,
    } as const;
    const searched = async (tokenHolder: string) =>
      (await instance.root.audit.query.search(viewer, { ...NONE, tokenHolder })).entries.flatMap(
        (e) => (e.kind === 'call' ? [e.token] : []),
      );
    expect(await searched(bob.email)).toEqual(
      Array.from({ length: 3 }, () => ({ kind: 'member', key: bob.id, label: bob.email })),
    );
    expect(await searched('CI runner')).toEqual(
      Array.from({ length: 2 }, () => ({ kind: 'named', key: 'CI runner', label: 'CI runner' })),
    );
    expect(await searched(`member:${ada.id}`)).toHaveLength(3);
    expect(await searched('nobody@example.com')).toEqual([]);
    expect(await searched('No such runner')).toEqual([]);
  });

  it('the holder is the token’s: nothing a caller sends changes who called', async () => {
    // Bob's token, declaring to be Ada in every way a caller can.
    const answer = await call(
      bobToken,
      { 'x-vaubaan-agent': ada.email, 'x-vaubaan-holder': ada.id, 'x-vaubaan-token': 'CI runner' },
      { agent: ada.email, holder: ada.id, token_holder: ada.id, token_kind: 'named' },
    );
    expect(allowed(answer.body)).toBe(true);
    const [entry] = await callEntries();
    expect(entry).toMatchObject({
      token_kind: 'member',
      token_holder: bob.id,
      // What was declared is kept as what it is: a label.
      agent_label: ada.email,
    });
    const missionLog = await instance.root.store.missionLogs.getByMission(mission.mission.id);
    const [event] = await instance.root.store.missionLogs.listEvents(missionLog?.id ?? '');
    expect(event?.details).toMatchObject({
      token_kind: 'member',
      holder: bob.id,
      agent_label: ada.email,
    });
  });

  it('the catalog says whose token is calling, and who created the mission', async () => {
    const asAda = await catalog(adaToken);
    const asBob = await catalog(bobToken);
    const asCi = await catalog(ciToken);
    expect(asAda.body.token).toMatchObject({ kind: 'member', holder: ada.email });
    expect(asBob.body.token).toMatchObject({ kind: 'member', holder: bob.email });
    expect(asCi.body.token).toMatchObject({ kind: 'named', holder: 'CI runner' });
    for (const answer of [asAda, asBob, asCi]) {
      expect(answer.status).toBe(200);
      expect(answer.body.mission).toMatchObject({ name: 'Team mission', creator: ada.email });
      // The prefix is the public part; no secret is in a catalog.
      expect(answer.body.token.prefix).toMatch(/^[A-Za-z0-9]{8}$/);
    }
    const text = JSON.stringify([asAda.body, asBob.body, asCi.body]);
    for (const bearer of [adaToken, bobToken, ciToken]) {
      expect(text).not.toContain(bearer.slice(-32));
    }
    // Same budget lines for every holder: one budget.
    expect(asBob.body.budget).toEqual(asAda.body.budget);
    expect(asCi.body.budget).toEqual(asAda.body.budget);
  });

  it('records when each token was last used, and nothing for a token never presented', async () => {
    await call(bobToken);
    const tokens = await instance.root.store.missions.listTokens(mission.mission.id);
    const lastUsed = (holder: string) =>
      tokens.find((t) => (t.holder.kind === 'member' ? t.holder.userId : t.holder.name) === holder)
        ?.lastUsedAt;
    expect(lastUsed(bob.id)).toEqual(expect.any(String));
    expect(lastUsed(ada.id)).toBeNull();
    expect(lastUsed('CI runner')).toBeNull();
    const team = await instance.root.missions.team.team(ada, mission.mission.id);
    expect(team?.tokens.map((t) => [t.holder.label, t.last_used_at !== null])).toEqual([
      [ada.email, false],
      [bob.email, true],
      ['CI runner', false],
    ]);
  });

  // ── A token that stops working ────────────────────────────────────────────

  it('refuses a removed member at the next call; the others keep working', async () => {
    // Every holder has called once: nothing of those calls is remembered.
    for (const token of [adaToken, bobToken, ciToken]) {
      expect(allowed((await call(token)).body)).toBe(true);
    }
    const before = (await callEntries()).length;

    const removed = await instance.root.missions.team.removeMember(ada, mission.mission.id, bob.id);
    expect(removed).toMatchObject({ ok: true, token_revoked: true });

    expectStopped(await call(bobToken), 'holder-removed');
    expect((await catalog(bobToken)).status).toBe(401);
    // Refused before the pipeline: nothing was counted, no call entry was written.
    expect((await callEntries()).length).toBe(before);
    expect(await consumed()).toBe(3);
    // The mission is untouched for its other holders.
    expect(await serves(adaToken)).toBe(true);
    expect(allowed((await call(ciToken)).body)).toBe(true);

    // Added again, the old token stays dead; a new one of his own works.
    await instance.root.missions.team.addMember(ada, mission.mission.id, { email: bob.email });
    expectStopped(await call(bobToken), 'token-revoked');
    expect(allowed((await call(await generate(bob))).body)).toBe(true);
  });

  it('refuses a member the moment their membership row says removed, even if their token row still reads active', async () => {
    expect(allowed((await call(bobToken)).body)).toBe(true);
    // Written straight into the store, bypassing the service that revokes the token:
    // the door reads membership on every call and does not rely on that write.
    instance.root.store.db
      .prepare(
        "UPDATE mission_members SET removed_at = '2026-10-13T00:00:00.000Z' WHERE user_id = ?",
      )
      .run(bob.id);
    const [row] = (await instance.root.store.missions.listTokens(mission.mission.id)).filter(
      (t) => t.holder.kind === 'member' && t.holder.userId === bob.id,
    );
    expect(row?.status).toBe('active');
    expectStopped(await call(bobToken), 'holder-removed');
  });

  it('refuses a deactivated member at once; reactivated, they generate a new token', async () => {
    expect(allowed((await call(bobToken)).body)).toBe(true);
    const operator = { actorId: ada.id, userId: ada.id };

    const deactivated = await instance.root.users.service.deactivate(operator, bob.id);
    expect(deactivated.memberTokensRevoked).toBe(1);
    expectStopped(await call(bobToken), 'holder-deactivated');
    expect(allowed((await call(adaToken)).body)).toBe(true);
    expect(allowed((await call(ciToken)).body)).toBe(true);

    // The revocation is in the audit, in the operator's name.
    const acts = (await instance.root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.act === 'mission-token-revoked' ? [e] : [],
    );
    expect(acts).toMatchObject([
      {
        user_id: ada.id,
        object: { type: 'mission', id: mission.mission.id },
        before: { token_kind: 'member', holder: bob.id },
        after: { status: 'revoked', reason: 'holder-deactivated' },
      },
    ]);
    const deactivation = (await instance.root.store.audit.list({ kind: 'admin' })).find(
      (e) => e.kind === 'admin' && e.act === 'user-deactivated',
    );
    expect(deactivation).toMatchObject({ after: { member_tokens_revoked: 1 } });

    // Reactivated: still a member, but the old Bearer does not come back to life.
    await instance.root.users.service.reactivate(operator, bob.id);
    expectStopped(await call(bobToken), 'token-revoked');
    expect(allowed((await call(await generate(bob))).body)).toBe(true);
  });

  it('refuses a member the moment their user row says removed, before anything else is written', async () => {
    expect(allowed((await call(bobToken)).body)).toBe(true);
    // The status alone, as the first write of a deactivation leaves it: the token row
    // is still `active`, and the door refuses it all the same.
    await instance.root.store.users.markRemoved(bob.id);
    expectStopped(await call(bobToken), 'holder-deactivated');
    // Nothing was revoked, so the same token serves again once the status is back.
    await instance.root.store.users.reactivate(bob.id);
    expect(allowed((await call(bobToken)).body)).toBe(true);
  });

  it('tells a rotated token from a revoked one, each on its own', async () => {
    for (const token of [bobToken, ciToken]) expect(allowed((await call(token)).body)).toBe(true);
    const { team } = instance.root.missions;

    const fresh = await generate(bob);
    expectStopped(await call(bobToken), 'token-rotated');
    expect(allowed((await call(fresh)).body)).toBe(true);

    const view = await team.team(ada, mission.mission.id);
    const ci = view?.tokens.find((t) => t.holder.label === 'CI runner');
    await team.revokeToken(ada, mission.mission.id, ci?.id ?? '');
    expectStopped(await call(ciToken), 'token-revoked');
    // Neither says anything about the mission: its other holders are served.
    expect(allowed((await call(adaToken)).body)).toBe(true);
    expect(allowed((await call(fresh)).body)).toBe(true);
  });

  // ── The mission still rules every holder ──────────────────────────────────

  it('a revoked mission is `mission-inactive` for its holders; a removed member is told nothing of it', async () => {
    await instance.root.missions.team.removeMember(ada, mission.mission.id, bob.id);
    await instance.root.missions.service.revoke(ada, mission.mission.id);
    for (const token of [adaToken, ciToken]) {
      const answer = await instance.rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(answer.body.error?.data).toMatchObject({
        code: 'mission-inactive',
        status: 'revoked',
      });
    }
    // Bob was removed before: he learns that, not what became of the mission.
    expectStopped(await call(bobToken), 'holder-removed');
  });

  it('a deactivated creator orphans the mission for every holder, and every token serves again once they are back', async () => {
    for (const token of [adaToken, bobToken, ciToken]) {
      expect(allowed((await call(token)).body)).toBe(true);
    }
    const carol = await instance.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|carol',
      email: 'carol@example.com',
    });
    const operator = { actorId: carol.id, userId: carol.id };
    const deactivated = await instance.root.users.service.deactivate(operator, ada.id);
    // Her own token is not a "member token of somebody else's mission": it is kept.
    expect(deactivated.memberTokensRevoked).toBe(0);
    for (const token of [adaToken, bobToken, ciToken]) {
      const answer = await instance.rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(answer.status).toBe(200);
      expect(answer.body.error?.data).toMatchObject({
        code: 'mission-inactive',
        status: 'orphaned',
      });
    }
    await instance.root.users.service.reactivate(operator, ada.id);
    for (const token of [adaToken, bobToken, ciToken]) {
      expect(await serves(token), token.slice(0, 17)).toBe(true);
    }
  });
});
