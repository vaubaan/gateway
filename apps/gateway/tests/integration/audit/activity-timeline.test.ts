/**
 * `ActivityTimelineService` on an ephemeral instance (spec §4.2 "Activity"):
 * the mission log events of every mission a person may read, scoped in SQL like
 * the Record, newest first, filtered by mission, and the requests of a page
 * linked for the creator only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_TIMELINE_FILTER, type AuditViewer } from '../../../src/server/audit';
import type { MissionRecord } from '../../../src/server/store/types';
import { seedAccount } from '../../support/missions/testing';
import {
  ARGUMENT_MARKER,
  issueMission,
  githubDraft,
  openAuditRig,
  PR,
  seedCall,
  userViewer,
  type OperatorRig,
} from './support';

describe('the Activity’s Timeline', () => {
  let rig: OperatorRig;
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    mission = await issueMission(rig);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const events = async (viewer: AuditViewer, filters = NO_TIMELINE_FILTER) =>
    (await rig.root.audit.timeline.search(viewer, filters)).events;

  it('lists the mission logs of the missions one created, newest first, each event under its mission', async () => {
    await seedCall(rig, mission);
    await seedCall(rig, mission, { tool: 'github__create_pull_request', risks: [PR] });
    const second = await issueMission(rig, rig.seeded.ada, githubDraft(rig, { name: 'Second' }));
    await seedCall(rig, second);

    const ada = await events(userViewer(rig.seeded.ada));
    expect(ada.map((e) => [e.mission.name, e.tool])).toEqual([
      ['Second', 'github__get_file'],
      [mission.name, 'github__create_pull_request'],
      [mission.name, 'github__get_file'],
    ]);
    const stamps = ada.map((e) => e.ts);
    expect(stamps).toEqual([...stamps].sort().reverse());
    // The mission filter narrows to one session.
    const one = await events(userViewer(rig.seeded.ada), {
      ...NO_TIMELINE_FILTER,
      missionId: second.id,
    });
    expect(one.map((e) => e.mission.id)).toEqual([second.id]);
    expect(JSON.stringify(ada)).not.toContain(ARGUMENT_MARKER);
  });

  it('another person reads none of them, even by naming the mission', async () => {
    await seedCall(rig, mission);
    const bob = userViewer(rig.seeded.bob);
    expect(await events(bob)).toEqual([]);
    expect(await events(bob, { ...NO_TIMELINE_FILTER, missionId: mission.id })).toEqual([]);
  });

  it('a current teammate reads the session; a removed one reads nothing of it', async () => {
    const { ada, bob } = rig.seeded;
    await seedCall(rig, mission);
    const added = await rig.root.missions.team.addMember(ada, mission.id, { email: bob.email });
    expect(added.ok).toBe(true);
    expect(await events(userViewer(bob))).toHaveLength(1);
    await rig.root.missions.team.removeMember(ada, mission.id, bob.id);
    expect(await events(userViewer(bob))).toEqual([]);
  });

  it('an administrator reads every session; the setup token reads none', async () => {
    await seedCall(rig, mission);
    expect(await events(userViewer(rig.operator, true))).toHaveLength(1);
    expect(await events({ kind: 'bootstrap' })).toEqual([]);
  });

  it('the owner of an account reads the calls through it in the Record, not the mission log', async () => {
    const bobs = await seedAccount(rig.root.store, {
      service: 'github',
      owner: { kind: 'user', id: rig.seeded.bob.id },
      displayName: 'bob-org',
      resources: [],
    });
    await seedCall(rig, mission, { accountId: bobs.account.id, resourceRef: 'bob/app' });
    expect(await events(userViewer(rig.seeded.bob))).toEqual([]);
    const record = await rig.root.audit.query.search(userViewer(rig.seeded.bob), {
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
    });
    expect(record.entries).toHaveLength(1);
  });

  it('links a waiting request for the creator only; a teammate reads whose answer it waits for', async () => {
    const { ada, bob } = rig.seeded;
    await rig.root.missions.team.addMember(ada, mission.id, { email: bob.email });
    const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
    await seedCall(rig, mission, pr);
    await seedCall(rig, mission, pr);
    // The quota of two is spent: the third is refused and a claim waits for Ada.
    await seedCall(rig, mission, pr);

    const asAda = await rig.root.audit.timeline.search(userViewer(ada), NO_TIMELINE_FILTER);
    expect(asAda.open_requests).toHaveLength(1);
    expect(asAda.open_requests[0]?.path).toMatch(/^\/waiting\//);
    expect(asAda.open_requests[0]?.creator).toBeNull();
    expect(asAda.events.some((e) => e.request_id === asAda.open_requests[0]?.id)).toBe(true);

    const asBob = await rig.root.audit.timeline.search(userViewer(bob), NO_TIMELINE_FILTER);
    expect(asBob.open_requests).toEqual([
      { id: asAda.open_requests[0]?.id, path: null, creator: ada.email },
    ]);
  });
});
