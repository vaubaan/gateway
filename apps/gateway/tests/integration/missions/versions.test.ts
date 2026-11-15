/**
 * The versions of a mission's configuration and their rollback (spec §4.2 "History",
 * §8 "Retention"), over the real composition root and store.
 *
 * What is proven here:
 *
 *   - every write path leaves exactly one version, with its cause and its author:
 *     issuance (by a person, by a mission through the `vaubaan` plugin), an edit, a
 *     permission request granted, a resource the mission created, a future resource
 *     joining, a gate and limits changed, a claim's new end, a rollback; a write that
 *     moves nothing leaves none;
 *   - restoring a version brings its configuration back as a NEW version, same key and
 *     same counters, under the creator's authority now (what they no longer hold is left
 *     out, and said); creator only; nothing changes when the version is already the
 *     configuration;
 *   - versions are immutable, survive the audit's retention purge, and go only with
 *     their mission.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf } from '../../../src/server/budget';
import { sameConfig } from '../../../src/lib/missions/versions';
import type { MissionDraft } from '../../../src/server/missions';
import type { MissionVersionRecord } from '../../../src/server/store/types';
import {
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const READ = 'depot.read';
const WRITE = 'depot[staging].write';

describe('mission versions', () => {
  let rig: ExecutionInstance;
  let mission: IssuedMission;

  beforeEach(async () => {
    rig = await executionInstance();
    mission = await rig.issue({ policy: [line(READ, 3)], spaces: ['app-staging'] });
  });
  afterEach(async () => {
    await rig.close();
  });

  const service = () => rig.root.missions.service;
  const versions = (id = mission.mission.id): Promise<MissionVersionRecord[]> =>
    rig.root.store.missionVersions.list(id);
  const latest = async (id = mission.mission.id): Promise<MissionVersionRecord> => {
    const [first] = await versions(id);
    if (!first) throw new Error('no version');
    return first;
  };
  const resourceId = (ref: string) => {
    const found = rig.resources.find((r) => r.ref === ref);
    if (!found) throw new Error(`no ${ref}`);
    return found.id;
  };
  /** The creator's edit: the mission's own draft with `change` applied. */
  const edit = async (change: (draft: MissionDraft) => MissionDraft) => {
    const current = await view();
    return service().edit(rig.ada, mission.mission.id, {
      draft: change(current.draft),
      revision: current.revision,
    });
  };
  const view = async () => {
    const found = await service().editView(rig.ada, mission.mission.id);
    if (!found) throw new Error('no edit view');
    return found;
  };
  const policy = async () => {
    const stored = await rig.root.store.missions.getById(mission.mission.id);
    if (!stored) throw new Error('missing mission');
    return budgetMissionOf(stored).policy;
  };

  it('issuance is version 1, by its creator', async () => {
    const [v1, ...rest] = await versions();
    expect(rest).toEqual([]);
    expect(v1).toMatchObject({
      number: 1,
      cause: 'issued',
      author: { kind: 'person', userId: rig.ada.id },
      restoredFrom: null,
      changes: null,
      config: { name: 'Test mission', expires_at: null },
    });
    expect(v1?.config.policy.map((p) => [p.risk_id, p.quota])).toEqual([[READ, 3]]);
    expect(v1?.config.accounts[0]?.resource_sets[0]?.resource_ids).toEqual([
      resourceId('app-staging'),
    ]);
  });

  it('a mission issued by an agent through the vaubaan plugin is version 1 by that mission', async () => {
    const issued = await service().issue(
      rig.ada,
      {
        name: 'Prepared by an agent',
        accounts: [
          {
            account_id: rig.account.id,
            resources: { scope: 'selected', resource_refs: ['app-staging'] },
            policy: [line(READ, 1)],
          },
        ],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      },
      { issuedBy: { missionId: mission.mission.id } },
    );
    if (!issued.ok) throw new Error(JSON.stringify(issued));
    expect(await versions(issued.mission.id)).toMatchObject([
      {
        number: 1,
        cause: 'issued',
        author: { kind: 'mission', missionId: mission.mission.id, userId: rig.ada.id },
      },
    ]);
  });

  it('an edit is one version, which lists what moved; an edit that moves nothing is none', async () => {
    const unchanged = await edit((draft) => draft);
    expect(unchanged).toMatchObject({ ok: true });
    expect(await versions()).toHaveLength(1);

    const result = await edit((draft) => ({
      ...draft,
      name: 'Renamed',
      accounts: draft.accounts.map((c) => ({ ...c, policy: [line(READ, 7)] })),
    }));
    expect(result).toMatchObject({ ok: true });
    const all = await versions();
    expect(all.map((v) => [v.number, v.cause])).toEqual([
      [2, 'edit'],
      [1, 'issued'],
    ]);
    expect(all[0]).toMatchObject({
      author: { kind: 'person', userId: rig.ada.id },
      changes: {
        name_changed: true,
        limits: [{ risk_id: READ, quota_before: 3, quota: 7 }],
      },
    });
  });

  it('a permission request granted is one version', async () => {
    const refused = await rig.call(mission, 'depot__write_item', { space: 'app-staging' });
    const refusalId = String(refused.error?.data?.refusal_id);
    const asked = await rig.call(mission, 'vaubaan__request_permission', {
      refusal_id: refusalId,
      reason: 'The task writes one item.',
    });
    const text = (asked.result?.content as { text: string }[])[0]?.text ?? '{}';
    const requestId = String((JSON.parse(text) as { request_id: unknown }).request_id);
    const granted = await service().changePermissions(rig.ada, mission.mission.id, {
      policy: [...(await policy()), line(WRITE, 2)],
      expected_policy: await policy(),
      request_id: requestId,
    });
    expect(granted).toMatchObject({ ok: true });
    expect(await latest()).toMatchObject({
      number: 2,
      cause: 'permission-request',
      author: { kind: 'person', userId: rig.ada.id },
      changes: { permissions_added: [WRITE] },
    });
    // Without a request, the same act is an edit.
    await service().changePermissions(rig.ada, mission.mission.id, {
      policy: [line(READ, 3)],
      expected_policy: await policy(),
    });
    expect((await latest()).cause).toBe('edit');
  });

  it('a resource the mission created joins as one version, by the gateway', async () => {
    const [created] = await rig.root.store.accounts
      .syncDiscoveredResources(rig.account.id, [
        ...rig.resources.map((r) => ({ ref: r.ref, displayName: r.displayName, env: r.env })),
        { ref: 'app-new', displayName: 'app-new', env: 'staging' },
      ])
      .then((rows) => rows.filter((r) => r.ref === 'app-new'));
    if (!created) throw new Error('no new resource');
    await rig.root.store.missions.addResources(
      mission.mission.id,
      rig.account.id,
      [created.id],
      'created',
      { tool: 'depot__create_space', actorUserId: rig.ada.id },
    );
    expect(await latest()).toMatchObject({
      number: 2,
      cause: 'resource-created',
      author: { kind: 'gateway' },
      changes: { resources_added: 1 },
    });
    // Added again: it is held already, nothing moves, no version.
    await rig.root.store.missions.addResources(
      mission.mission.id,
      rig.account.id,
      [created.id],
      'created',
      { tool: 'depot__create_space', actorUserId: rig.ada.id },
    );
    expect(await versions()).toHaveLength(2);
  });

  it('a resource joining a set of future resources is one version, by the gateway', async () => {
    const whole = await rig.issue({ policy: [line(READ, 3)], wholeAccount: true });
    expect(await versions(whole.mission.id)).toHaveLength(1);
    const rows = await rig.root.store.accounts.syncDiscoveredResources(rig.account.id, [
      ...rig.resources.map((r) => ({ ref: r.ref, displayName: r.displayName, env: r.env })),
      { ref: 'app-later', displayName: 'app-later', env: 'staging' },
    ]);
    const later = rows.find((r) => r.ref === 'app-later');
    if (!later) throw new Error('no later resource');
    const moves = await rig.root.store.missions.applyResourceChanges(
      rig.account.id,
      [{ resourceId: later.id, reason: 'discovered' }],
      [],
    );
    expect(moves.filter((m) => m.missionId === whole.mission.id)).toHaveLength(1);
    expect(await latest(whole.mission.id)).toMatchObject({
      number: 2,
      cause: 'resources-discovered',
      author: { kind: 'gateway' },
    });
    // The mission that does not take future resources moved nothing: no version.
    expect(await versions()).toHaveLength(1);
  });

  it('a gate and limits changed are one version each; the same values again are none', async () => {
    expect(await service().setGate(rig.ada, mission.mission.id, READ, 'approval')).toMatchObject({
      ok: true,
    });
    expect(await latest()).toMatchObject({ number: 2, cause: 'edit' });
    expect(
      await service().setLimits(rig.ada, mission.mission.id, [
        { risk_id: READ, quota: 9, rate_limit_max: 5 },
      ]),
    ).toMatchObject({ ok: true });
    expect(await latest()).toMatchObject({
      number: 3,
      cause: 'edit',
      changes: { limits: [{ risk_id: READ, quota: 9 }] },
    });
    // The same values again move nothing.
    await service().setLimits(rig.ada, mission.mission.id, [
      { risk_id: READ, quota: 9, rate_limit_max: 5 },
    ]);
    expect(await versions()).toHaveLength(3);
  });

  it('a claim answered with a new end is one version, by who answered', async () => {
    const claim = await rig.root.store.requests.create({
      missionId: mission.mission.id,
      kind: 'claim',
      riskId: READ,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await rig.root.store.requests.decideClaim(claim.id, rig.ada.id, (ctx) => {
      ctx.setMissionExpiry('2098-12-01T00:00:00.000Z');
      return { state: 'granted', decision: { resolution: 'extend-expiry' } };
    });
    expect(await latest()).toMatchObject({
      number: 2,
      cause: 'claim-granted',
      author: { kind: 'person', userId: rig.ada.id },
      config: { expires_at: '2098-12-01T00:00:00.000Z' },
    });
  });

  describe('restore', () => {
    /** Two edits: v2 adds the write permission, v3 renames and lowers the read quota. */
    async function twoEdits() {
      await edit((draft) => ({
        ...draft,
        accounts: draft.accounts.map((c) => ({ ...c, policy: [line(READ, 3), line(WRITE, 2)] })),
      }));
      await edit((draft) => ({
        ...draft,
        name: 'Second name',
        accounts: draft.accounts.map((c) => ({
          ...c,
          resources: {
            scope: 'selected',
            resource_ids: [resourceId('app-staging'), resourceId('scratch')],
          },
          policy: [line(READ, 1), line(WRITE, 2)],
        })),
      }));
      expect((await versions()).map((v) => v.number)).toEqual([3, 2, 1]);
    }

    it('brings version 1 back as version 4, same key, same counters', async () => {
      await rig.call(mission, 'depot__read_item', { space: 'app-staging' });
      await twoEdits();
      const tokens = await rig.root.store.missions.listTokens(mission.mission.id);

      const restored = await service().restore(rig.ada, mission.mission.id, 1);
      expect(restored).toMatchObject({ ok: true, version: 4, restored_from: 1, dropped: [] });

      const all = await versions();
      expect(all.map((v) => v.number)).toEqual([4, 3, 2, 1]);
      const [v4] = all;
      const v1 = all.at(-1);
      expect(v4).toMatchObject({
        cause: 'rollback',
        restoredFrom: 1,
        author: { kind: 'person', userId: rig.ada.id },
      });
      expect(v4 && v1 && sameConfig(v4.config, v1.config)).toBe(true);
      // History is never rewritten: versions 2 and 3 are as they were.
      expect(all[1]?.config.name).toBe('Second name');

      expect(await rig.root.store.missions.listTokens(mission.mission.id)).toEqual(tokens);
      const stored = await rig.root.store.missions.getById(mission.mission.id);
      const usage = await rig.root.budget.usageOf(budgetMissionOf(stored!), new Date());
      expect([...usage.consumed.values()]).toEqual([1]);
      // The agent's next call sees version 1 again: the write permission is gone.
      expect(
        (await rig.call(mission, 'depot__write_item', { space: 'app-staging' })).error?.data?.code,
      ).toBe('risk-not-accepted');

      const audit = (await rig.root.store.audit.list({ kind: 'admin' })).filter(
        (e) => e.kind === 'admin' && e.act === 'mission-changed',
      );
      expect(audit.at(-1)).toMatchObject({ after: { restored_from: 1 } });
    });

    it('restores the current configuration as nothing', async () => {
      await twoEdits();
      expect(await service().restore(rig.ada, mission.mission.id, 3)).toMatchObject({
        ok: true,
        version: null,
      });
      expect(await versions()).toHaveLength(3);
    });

    it('leaves out a resource that no longer exists, and says so', async () => {
      await twoEdits();
      // `scratch` disappears from the account: discovery no longer returns it.
      await rig.root.store.accounts.syncDiscoveredResources(
        rig.account.id,
        rig.resources
          .filter((r) => r.ref !== 'scratch')
          .map((r) => ({ ref: r.ref, displayName: r.displayName, env: r.env })),
      );
      rig.root.store.db
        .prepare(
          "UPDATE account_resources SET stale_since = '2000-01-01T00:00:00.000Z' WHERE ref = 'scratch'",
        )
        .run();
      await service().restore(rig.ada, mission.mission.id, 1);
      const restored = await service().restore(rig.ada, mission.mission.id, 3);
      expect(restored).toMatchObject({ ok: true, version: 5 });
      if (!restored.ok) throw new Error('refused');
      expect(restored.dropped).toEqual(['scratch on Depot main is left out: it no longer exists.']);
      expect((await latest()).config.accounts[0]?.resource_sets[0]?.resource_ids).toEqual([
        resourceId('app-staging'),
      ]);
    });

    it('is the creator’s alone, and not on a revoked mission', async () => {
      await twoEdits();
      const bob = await rig.root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'bob',
        email: 'bob@example.com',
      });
      expect(await service().restore(bob, mission.mission.id, 1)).toEqual({
        ok: false,
        reason: 'not-found',
      });
      expect(await service().restore(rig.ada, mission.mission.id, 99)).toEqual({
        ok: false,
        reason: 'not-found',
      });
      await rig.root.store.missions.setStatus(mission.mission.id, 'revoked');
      expect(await service().restore(rig.ada, mission.mission.id, 1)).toMatchObject({
        ok: false,
        reason: 'inactive',
      });
    });

    it('is offered on the history to the creator, worded', async () => {
      await twoEdits();
      const history = await service().history(rig.ada, mission.mission.id);
      expect(history?.restorable).toBe(true);
      expect(history?.versions.map((v) => [v.number, v.cause, v.current])).toEqual([
        [3, 'edit', true],
        [2, 'edit', false],
        [1, 'issued', false],
      ]);
      expect(history?.versions[0]?.author).toEqual({
        kind: 'person',
        label: 'ada@example.com',
        mission_id: null,
      });
      expect(history?.versions[0]?.clauses).toEqual(
        expect.arrayContaining(['renamed', '1 resource added', `quota of ${READ} 3 → 1`]),
      );
      expect(history?.versions[0]?.details).toEqual(
        expect.arrayContaining([
          'Renamed from “Test mission” to “Second name”',
          'Depot main, resource set 1: added scratch',
        ]),
      );
      expect(history?.versions[2]?.details).toEqual([]);
      const stranger = await rig.root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'stranger',
        email: 'stranger@example.com',
      });
      expect(await service().history(stranger, mission.mission.id)).toBeNull();
    });
  });

  describe('kept as long as the mission', () => {
    it('is immutable: no update, no delete while the mission exists', async () => {
      const db = rig.root.store.db;
      expect(() =>
        db
          .prepare("UPDATE mission_versions SET cause = 'edit' WHERE mission_id = ?")
          .run(mission.mission.id),
      ).toThrow(/immutable/);
      expect(() =>
        db.prepare('DELETE FROM mission_versions WHERE mission_id = ?').run(mission.mission.id),
      ).toThrow(/only with its mission/);
    });

    it('survives the audit’s retention purge', async () => {
      await rig.root.store.audit.purgeOlderThan('2999-01-01T00:00:00.000Z');
      expect(await versions()).toHaveLength(1);
    });

    it('goes with its mission row: the cascade takes them, and the trigger lets it', async () => {
      rig.root.store.db.prepare('DELETE FROM missions WHERE id = ?').run(mission.mission.id);
      expect(await versions()).toEqual([]);
    });
  });
});
