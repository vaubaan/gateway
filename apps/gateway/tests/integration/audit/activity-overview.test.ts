/**
 * `ActivityOverviewService` on an ephemeral instance (spec §4.2 "Activity",
 * Overview): the missions of the Timeline's scope, scoped in SQL, with their
 * calls, bytes, accounts, key holders, use of the period and what expires
 * soon; and the bytes of a call as the store keeps them (migration 0038).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXPIRING_SOON_DAYS, type AuditViewer } from '../../../src/server/audit';
import type { MissionRecord } from '../../../src/server/store/types';
import { seedAccount } from '../../support/missions/testing';
import {
  githubDraft,
  issueMission,
  openAuditRig,
  PR,
  READ,
  SEEDED_RESPONSE_BYTES,
  seedCall,
  userViewer,
  type OperatorRig,
} from './support';

const DAY_MS = 86_400_000;

describe('the Overview of Activity', () => {
  let rig: OperatorRig;
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    mission = await issueMission(rig);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const overview = (viewer: AuditViewer, period: '7d' | 'today' | '30d' = '7d') =>
    rig.root.audit.overview.overview(viewer, period);

  it('sums a mission’s calls, waiting requests and bytes, per account and per key holder', async () => {
    const { ada } = rig.seeded;
    await seedCall(rig, mission, { requestBytes: 100, responseBytes: 5_000 });
    await seedCall(rig, mission, { requestBytes: 50, responseBytes: null });
    const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
    await seedCall(rig, mission, pr);
    await seedCall(rig, mission, pr);
    // The quota of two pull requests is spent: refused, and a claim waits for Ada.
    await seedCall(rig, mission, pr);
    // A machine key of the mission.
    await seedCall(rig, mission, {
      token: { token_id: 'ci-token', token_kind: 'named', holder: 'ci-runner' },
      requestBytes: 10,
      responseBytes: 10,
    });

    const view = await overview(userViewer(ada));
    expect(view.missions.map((m) => m.id)).toEqual([mission.id]);
    const [one] = view.missions;
    expect(one?.totals).toMatchObject({ allowed: 5, refused: 1, waiting: 1 });
    // Known counts summed; a refused call and an unknown response add nothing.
    expect(one?.totals.request_bytes).toBeGreaterThan(160);
    expect(one?.totals.response_bytes).toBe(5_000 + 2 * SEEDED_RESPONSE_BYTES + 10);

    expect(one?.accounts).toHaveLength(1);
    expect(one?.accounts[0]).toMatchObject({
      id: rig.seeded.github.account.id,
      service: 'github',
      allowed: 5,
      refused: 1,
    });
    expect(one?.holders.map((h) => [h.holder?.label, h.allowed + h.refused])).toEqual([
      [ada.email, 5],
      ['ci-runner', 1],
    ]);
    expect(one?.holders[0]?.share).toBeCloseTo(5 / 6);
    expect(one?.holders[1]?.holder).toMatchObject({ kind: 'named', key: 'ci-runner' });

    // The use of the period comes from the budget: two of two pull requests, two of five reads… and the machine key's read.
    const lines = new Map(one?.accounts[0]?.lines.map((l) => [l.risk_id, l]));
    expect(lines.get(PR)).toMatchObject({ quota: 2, used: 2 });
    expect(lines.get(READ)).toMatchObject({ quota: 5, used: 3 });
  });

  it('keeps the span: a call older than the period is not summed', async () => {
    await seedCall(rig, mission, { now: new Date(Date.now() - 10 * DAY_MS) });
    await seedCall(rig, mission);
    expect((await overview(userViewer(rig.seeded.ada), '7d')).missions[0]?.totals.allowed).toBe(1);
    expect((await overview(userViewer(rig.seeded.ada), '30d')).missions[0]?.totals.allowed).toBe(2);
  });

  it('a teammate reads the mission; another person and the owner of an account through it read nothing', async () => {
    const { ada, bob } = rig.seeded;
    const bobs = await seedAccount(rig.root.store, {
      service: 'github',
      owner: { kind: 'user', id: bob.id },
      displayName: 'bob-org',
      resources: [],
    });
    await seedCall(rig, mission, { accountId: bobs.account.id, resourceRef: 'bob/app' });
    // Bob owns the account the call went through: the Record shows it to him, not the Overview.
    expect((await overview(userViewer(bob))).missions).toEqual([]);

    const added = await rig.root.missions.team.addMember(ada, mission.id, { email: bob.email });
    expect(added.ok).toBe(true);
    const asTeammate = await overview(userViewer(bob));
    expect(asTeammate.missions.map((m) => [m.id, m.created_by_viewer])).toEqual([
      [mission.id, false],
    ]);
    await rig.root.missions.team.removeMember(ada, mission.id, bob.id);
    expect((await overview(userViewer(bob))).missions).toEqual([]);
  });

  it('an administrator reads every mission; the setup token reads none', async () => {
    await seedCall(rig, mission);
    expect((await overview(userViewer(rig.operator, true))).missions).toHaveLength(1);
    expect((await overview({ kind: 'bootstrap' })).missions).toEqual([]);
  });

  it('a stopped mission shows only when it was called in the span', async () => {
    const { ada } = rig.seeded;
    const quiet = await issueMission(rig, ada, githubDraft(rig, { name: 'Quiet' }));
    await rig.root.missions.service.revoke(ada, quiet.id);
    const ids = (await overview(userViewer(ada))).missions.map((m) => m.id);
    expect(ids).toEqual([mission.id]);
  });

  it('lists what stops working soon: a mission’s end, a key that ends, an account refused', async () => {
    const { ada, bob } = rig.seeded;
    const soon = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const ending = await issueMission(
      rig,
      ada,
      githubDraft(rig, { name: 'Ending', expires_at: soon }),
    );
    // A pasted key that ends in two days.
    const keyEnd = new Date(Date.now() + 2 * DAY_MS).toISOString();
    expect(
      await rig.root.store.accounts.refreshCredential(
        rig.seeded.github.account.id,
        JSON.stringify({ kind: 'test' }),
        keyEnd,
      ),
    ).toBe(true);

    const asAda = await overview(userViewer(ada));
    expect(asAda.expiring).toEqual([
      expect.objectContaining({
        kind: 'account',
        expires_at: keyEnd,
        expired: false,
        fixable: true,
      }),
      expect.objectContaining({ kind: 'mission', mission_id: ending.id, fixable: true }),
    ]);

    // A teammate reads them too, and fixes neither.
    await rig.root.missions.team.addMember(ada, ending.id, { email: bob.email });
    const asBob = await overview(userViewer(bob));
    expect(asBob.expiring.map((e) => [e.kind, e.fixable])).toEqual([
      ['account', false],
      ['mission', false],
    ]);

    // Once the service refused the key, the account comes first, whatever its date.
    await rig.root.store.accounts.markExpired(rig.seeded.github.account.id);
    const refused = await overview(userViewer(ada));
    expect(refused.expiring[0]).toMatchObject({ kind: 'account', expired: true, expires_at: null });
  });

  it('says nothing of an end beyond the window', async () => {
    const later = new Date(Date.now() + (EXPIRING_SOON_DAYS + 2) * DAY_MS).toISOString();
    await issueMission(rig, rig.seeded.ada, githubDraft(rig, { name: 'Later', expires_at: later }));
    expect((await overview(userViewer(rig.seeded.ada))).expiring).toEqual([]);
  });
});

describe('the bytes of a call in the store', () => {
  let rig: OperatorRig;
  afterEach(async () => {
    await rig.root.close();
  });

  it('are written with the entry and read back; an entry without them reads null', async () => {
    rig = await openAuditRig();
    const mission = await issueMission(rig);
    const counted = await seedCall(rig, mission, { requestBytes: 321, responseBytes: 654 });
    const uncounted = await seedCall(rig, mission, { requestBytes: null, responseBytes: null });
    const entries = await rig.root.store.audit.list({ missionId: mission.id, kind: 'call' });
    expect(
      entries.map((e) => (e.kind === 'call' ? [e.request_bytes, e.response_bytes] : null)),
    ).toEqual([
      [321, 654],
      [null, null],
    ]);
    expect(counted.entry.request_bytes).toBe(321);
    expect(uncounted.entry.request_bytes).toBeNull();
  });
});
