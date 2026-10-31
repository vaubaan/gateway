/**
 * `AuditQueryService` on an ephemeral instance (spec §4.2 "Audit", §8):
 * the visibility rule, every filter, keyset paging, and "nobody sees raw
 * arguments". Calls are seeded through `SessionService.recordCall` and the
 * store's audit writer (see `support.ts`); administrative entries come from
 * the real services.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_ACTOR_ID,
  BOOTSTRAP_ACTOR_LABEL,
  type AdminAct,
  type AdminObjectType,
} from '@vaubaan/gateway-core';

import {
  ARGUMENTS_NOT_SHOWN,
  parseAuditQuery,
  standingOn,
  type AuditCallView,
  type AuditEntryView,
  type AuditFilters,
  type AuditViewer,
} from '../../../src/server/audit';
import { seedConnection } from '../../../src/server/missions/testing';
import type { MissionRecord } from '../../../src/server/store/types';
import {
  ARGUMENT_MARKER,
  githubDraft,
  issueMission,
  MERGE,
  NO_FILTER,
  openAuditRig,
  PR,
  READ,
  seedCall,
  userViewer,
  type OperatorRig,
} from './support';

const BOOTSTRAP: AuditViewer = { kind: 'bootstrap' };

describe('audit search: visibility, filters, paging', () => {
  let rig: OperatorRig;
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    mission = await issueMission(rig);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  /** A mission Bob creates on a GitHub connection of his own: nothing of Ada's is in it. */
  async function bobsMission(name = 'Bob own'): Promise<MissionRecord> {
    const bobs = await seedConnection(rig.root.store, {
      provider: 'github',
      owner: { kind: 'user', id: rig.seeded.bob.id },
      displayName: 'bob-org',
      resources: [],
    });
    const draft = githubDraft(rig);
    return issueMission(rig, rig.seeded.bob, {
      ...draft,
      name,
      connections: [{ ...draft.connections[0]!, connection_id: bobs.connection.id }],
    });
  }

  const search = async (
    viewer: AuditViewer,
    filters: Partial<AuditFilters> = {},
  ): Promise<readonly AuditEntryView[]> =>
    (await rig.root.audit.query.search(viewer, { ...NO_FILTER, ...filters })).entries;

  const calls = (entries: readonly AuditEntryView[]): AuditCallView[] =>
    entries.filter((e): e is AuditCallView => e.kind === 'call');

  const acts = (entries: readonly AuditEntryView[]): string[] =>
    entries.flatMap((e) => (e.kind === 'admin' ? [e.act] : []));

  async function configChange(): Promise<void> {
    await rig.root.store.auditWriter.write({
      kind: 'admin',
      ts: new Date().toISOString(),
      user_id: rig.operator.id,
      act: 'config-changed',
      object: { type: 'instance-config', id: 'idp' },
      before: null,
      after: { issuer: 'https://idp.example.com/' },
      delegated_client_id: null,
    });
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  it('a user sees the calls and the acts of the missions they created; another user sees none of them', async () => {
    await seedCall(rig, mission);
    await seedCall(rig, mission, { tool: 'github__create_pull_request', risks: [PR] });

    const ada = await search(userViewer(rig.seeded.ada));
    expect(calls(ada).map((c) => c.tool)).toEqual([
      'github__create_pull_request',
      'github__get_file',
    ]);
    expect(calls(ada)[0]?.mission).toEqual({
      id: mission.id,
      name: 'Ship the billing page',
      creator_email: 'ada@example.com',
    });
    expect(acts(ada)).toEqual(['mission-issued']);

    expect(await search(userViewer(rig.seeded.bob))).toEqual([]);
  });

  it('the owner of a connection sees the calls made through it by a mission they did not create', async () => {
    // What a share will allow: Ada's mission calls through Bob's connection.
    const bobs = await seedConnection(rig.root.store, {
      provider: 'github',
      owner: { kind: 'user', id: rig.seeded.bob.id },
      displayName: 'bob-org',
      resources: [],
    });
    await seedCall(rig, mission, { connectionId: bobs.connection.id, resourceRef: 'bob/app' });
    await seedCall(rig, mission);

    const bob = calls(await search(userViewer(rig.seeded.bob)));
    expect(bob).toHaveLength(1);
    expect(bob[0]?.connection).toEqual({
      id: bobs.connection.id,
      display_name: 'bob-org',
      provider: 'github',
    });
    expect(bob[0]?.resource_ref).toBe('bob/app');
  });

  it('a member of the owning group sees the connection, a non-member does not', async () => {
    const group = await rig.root.store.groups.getOrCreate('platform', 'idp');
    await rig.root.store.groups.addMember(group.id, rig.seeded.bob.id);
    const shared = await seedConnection(rig.root.store, {
      provider: 'github',
      owner: { kind: 'group', id: group.id },
      displayName: 'platform-org',
      resources: [],
    });
    await seedCall(rig, mission, { connectionId: shared.connection.id });

    expect(calls(await search(userViewer(rig.seeded.bob, false, [group.id])))).toHaveLength(1);
    expect(await search(userViewer(rig.seeded.bob))).toEqual([]);
  });

  // ── Members (spec §4.2 "Audit": the missions shared with me) ──────────────

  describe('a member of a mission', () => {
    const team = () => rig.root.missions.team;
    const asBob = () => userViewer(rig.seeded.bob);

    it('sees the calls and the acts of a mission shared with them, and nothing of any other mission', async () => {
      const other = await issueMission(rig, rig.seeded.ada, {
        ...githubDraft(rig),
        name: 'Not shared',
      });
      await seedCall(rig, mission);
      await seedCall(rig, other);
      expect(await search(asBob())).toEqual([]);

      const added = await team().addMember(rig.seeded.ada, mission.id, {
        email: rig.seeded.bob.email,
      });
      expect(added.ok).toBe(true);

      const bob = await search(asBob());
      expect(calls(bob).map((c) => [c.mission.name, c.tool])).toEqual([
        ['Ship the billing page', 'github__get_file'],
      ]);
      expect(acts(bob).sort()).toEqual(['mission-issued', 'mission-member-added']);
      expect(JSON.stringify(bob)).not.toContain('Not shared');
      // The creator's own view is unchanged by the membership.
      expect(calls(await search(userViewer(rig.seeded.ada)))).toHaveLength(2);
    });

    it('is never shown arguments, nor their fingerprint: the creator is', async () => {
      const { entry } = await seedCall(rig, mission);
      await team().addMember(rig.seeded.ada, mission.id, { email: rig.seeded.bob.email });

      const [asMember] = calls(await search(asBob()));
      expect(asMember?.arguments_hash).toBeNull();
      const page = JSON.stringify(await rig.root.audit.query.search(asBob(), NO_FILTER));
      expect(page).not.toContain(ARGUMENT_MARKER);
      expect(page).not.toContain(entry.arguments_hash);

      const [asCreator] = calls(await search(userViewer(rig.seeded.ada)));
      expect(asCreator?.arguments_hash).toBe(entry.arguments_hash);
    });

    it('sees the requests of the mission without the fingerprint they carry', async () => {
      await team().addMember(rig.seeded.ada, mission.id, { email: rig.seeded.bob.email });
      const fingerprint = 'c'.repeat(64);
      // Exhaust the pull-request quota (2): the third call drops a request.
      for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
      const refused = await seedCall(rig, mission, { risks: [PR] });
      if (refused.result.outcome !== 'refused' || !refused.result.request_id) {
        throw new Error('expected a request');
      }
      const request = { id: refused.result.request_id };
      await rig.root.store.auditWriter.write({
        kind: 'admin',
        ts: new Date().toISOString(),
        user_id: rig.seeded.ada.id,
        act: 'approval-granted',
        object: { type: 'request', id: request.id },
        before: { status: 'open' },
        after: { status: 'granted', tool: 'github__create_pull_request', fingerprint },
        delegated_client_id: null,
      });

      const bob = await search(asBob());
      const granted = bob.find((e) => e.kind === 'admin' && e.act === 'approval-granted');
      expect(granted).toMatchObject({
        after: { status: 'granted', fingerprint: ARGUMENTS_NOT_SHOWN },
      });
      const ada = await search(userViewer(rig.seeded.ada));
      expect(ada.find((e) => e.kind === 'admin' && e.act === 'approval-granted')).toMatchObject({
        after: { fingerprint },
      });
    });

    it('removed from the mission, reads none of it any more — past entries included', async () => {
      await seedCall(rig, mission);
      await team().addMember(rig.seeded.ada, mission.id, { email: rig.seeded.bob.email });
      expect(calls(await search(asBob()))).toHaveLength(1);

      const removed = await team().removeMember(rig.seeded.ada, mission.id, rig.seeded.bob.id);
      expect(removed.ok).toBe(true);
      expect(await search(asBob())).toEqual([]);
      expect(await search(asBob(), { missionId: mission.id })).toEqual([]);
    });

    it('is offered the mission as a filter value, with the missions they created', async () => {
      await team().addMember(rig.seeded.ada, mission.id, { email: rig.seeded.bob.email });
      const own = await bobsMission();
      const options = await rig.root.audit.query.filterOptions(asBob());
      expect(options.missions.map((m) => m.id).sort()).toEqual([mission.id, own.id].sort());
    });
  });

  it('administrative entries: an operator sees them all, a user only those on their missions and connections', async () => {
    await configChange();
    await rig.root.connections.service.updateResource(
      { user: rig.seeded.ada, groups: [] },
      rig.seeded.github.connection.id,
      rig.seeded.github.resources[0]!.id,
      { hidden: true },
    );

    expect(acts(await search(userViewer(rig.seeded.ada))).sort()).toEqual([
      'mission-issued',
      'resource-edited',
    ]);
    expect(acts(await search(userViewer(rig.seeded.bob)))).toEqual([]);
    // The boot applied the configuration's admin rule: `administrators-seeded`.
    expect(acts(await search(userViewer(rig.operator, true))).sort()).toEqual([
      'administrators-seeded',
      'config-changed',
      'mission-issued',
      'resource-edited',
    ]);
    // The bootstrap operator owns nothing and sees the administrative entries, no call.
    await seedCall(rig, mission);
    expect(acts(await search(BOOTSTRAP)).sort()).toEqual([
      'administrators-seeded',
      'config-changed',
      'mission-issued',
      'resource-edited',
    ]);
    expect(calls(await search(BOOTSTRAP))).toEqual([]);
  });

  it('every dimension of the scope at once: created, member of, owned through a group — and nothing else', async () => {
    // Bob created one mission, is a member of Ada's, and owns through a group a
    // connection a third mission of Ada's calls through. A fourth mission is nobody's of his.
    const created = await bobsMission('Created by Bob');
    await rig.root.missions.team.addMember(rig.seeded.ada, mission.id, {
      email: rig.seeded.bob.email,
    });
    const group = await rig.root.store.groups.getOrCreate('platform', 'idp');
    await rig.root.store.groups.addMember(group.id, rig.seeded.bob.id);
    const groupOwned = await seedConnection(rig.root.store, {
      provider: 'github',
      owner: { kind: 'group', id: group.id },
      displayName: 'platform-org',
      resources: [],
    });
    const through = await issueMission(rig, rig.seeded.ada, {
      ...githubDraft(rig),
      name: 'Through the group connection',
    });
    const unrelated = await issueMission(rig, rig.seeded.ada, {
      ...githubDraft(rig),
      name: 'Unrelated',
    });
    await seedCall(rig, created, { tool: 'github__get_file' });
    await seedCall(rig, mission, { tool: 'github__list_branches' });
    await seedCall(rig, through, {
      tool: 'github__get_commit',
      connectionId: groupOwned.connection.id,
    });
    await seedCall(rig, unrelated, { tool: 'github__list_tags' });

    const bob = userViewer(rig.seeded.bob, false, [group.id]);
    const seen = calls(await search(bob));
    expect(seen.map((c) => c.mission.name).sort()).toEqual([
      'Created by Bob',
      'Ship the billing page',
      'Through the group connection',
    ]);
    // The fingerprint follows the standing, entry by entry.
    const shown: Record<string, boolean> = Object.fromEntries(
      seen.map((c) => [c.mission.name ?? c.mission.id, c.arguments_hash !== null]),
    );
    expect(shown).toEqual({
      'Created by Bob': true, // creator
      'Ship the billing page': false, // member only
      'Through the group connection': true, // owner of the connection, through the group
    });
    expect(JSON.stringify(await search(bob))).not.toContain('Unrelated');
    // Without the group, the connection's calls are gone; the two others stay.
    expect(
      calls(await search(userViewer(rig.seeded.bob)))
        .map((c) => c.mission.name)
        .sort(),
    ).toEqual(['Created by Bob', 'Ship the billing page']);
  });

  // ── Operators (spec §4.2 "Audit": every entry, never arguments) ───────────

  describe('an operator', () => {
    const asOperator = () => userViewer(rig.operator, true);

    it('sees every call of the instance, allowed or refused, whoever created the mission', async () => {
      const bobs = await bobsMission();
      await seedCall(rig, mission);
      await seedCall(rig, bobs, { tool: 'github__create_pull_request', risks: [PR] });

      const seen = calls(await search(asOperator()));
      expect(seen.map((c) => [c.mission.name, c.tool]).sort()).toEqual([
        ['Bob own', 'github__create_pull_request'],
        ['Ship the billing page', 'github__get_file'],
      ]);
      // Someone who is not an operator, with the same nothing-of-their-own, sees none.
      expect(calls(await search(userViewer(rig.operator, false)))).toEqual([]);
    });

    it('is never shown arguments, nor their fingerprint, on a mission that is not theirs', async () => {
      const { entry } = await seedCall(rig, mission);
      const [call] = calls(await search(asOperator()));
      expect(call?.arguments_hash).toBeNull();
      const page = JSON.stringify(await rig.root.audit.query.search(asOperator(), NO_FILTER));
      expect(page).not.toContain(ARGUMENT_MARKER);
      expect(page).not.toContain(entry.arguments_hash);
    });

    it('who also answers for a call is shown its fingerprint, like any creator or owner', async () => {
      // Being an operator takes nothing away: the standing is decided call by call.
      expect(standingOn(asOperator(), { creatorUserId: rig.operator.id }, null)).toBe(
        'responsible',
      );
      const { entry } = await seedCall(rig, mission);
      const adaAsOperator = userViewer(rig.seeded.ada, true);
      const [call] = calls(await search(adaAsOperator, { missionId: mission.id }));
      expect(call?.arguments_hash).toBe(entry.arguments_hash);
    });

    it('filters narrow what an operator sees like anybody else', async () => {
      const bobs = await bobsMission();
      await seedCall(rig, mission);
      await seedCall(rig, bobs);
      expect(
        calls(await search(asOperator(), { missionId: bobs.id })).map((c) => c.mission.name),
      ).toEqual(['Bob own']);
      expect(calls(await search(asOperator(), { kind: 'admin' }))).toEqual([]);
    });
  });

  it('administrative entries name their actor and their object', async () => {
    await configChange();
    const entries = await search(userViewer(rig.operator, true));
    const issued = entries.find((e) => e.kind === 'admin' && e.act === 'mission-issued');
    expect(issued).toMatchObject({
      actor: { id: rig.seeded.ada.id, email: 'ada@example.com' },
      object: { type: 'mission', id: mission.id, label: 'Ship the billing page' },
    });
    const config = entries.find((e) => e.kind === 'admin' && e.act === 'config-changed');
    expect(config).toMatchObject({
      actor: { email: 'ops@example.com', label: 'ops@example.com' },
      object: { type: 'instance-config', id: 'idp', label: null },
    });
  });

  it('names the object of every administrative entry, whatever its type', async () => {
    const { store } = rig.root;
    const connection = rig.seeded.github.connection;
    const group = await store.groups.createLocal('Platform');
    if (!group) throw new Error('expected a group');
    const toUser = await store.shares.create({
      connectionId: connection.id,
      target: { kind: 'user', id: rig.seeded.bob.id },
      restriction: [READ],
      createdByUserId: rig.seeded.ada.id,
    });
    const toGroup = await store.shares.create({
      connectionId: connection.id,
      target: { kind: 'group', id: group.id },
      restriction: [READ],
      createdByUserId: rig.seeded.ada.id,
    });
    const client = await store.delegations.registerClient({
      clientId: 'client-public-id',
      name: 'Desk Agent',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    const delegation = await store.delegations.create({
      userId: rig.seeded.ada.id,
      clientId: client.id,
      scope: 'missions',
    });
    for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
    const claim = await seedCall(rig, mission, { risks: [PR] });
    const approval = await seedCall(rig, mission, {
      tool: 'github__merge_pull_request',
      risks: [MERGE],
    });
    if (claim.result.outcome !== 'refused' || approval.result.outcome !== 'refused') {
      throw new Error('expected two refusals');
    }

    // One entry per object type, with the act a real writer uses for it.
    const objects: readonly (readonly [AdminAct, AdminObjectType, string])[] = [
      ['mission-rotated', 'mission', mission.id],
      ['resource-edited', 'connection', connection.id],
      ['share-created', 'share', toUser.id],
      ['share-revoked', 'share', toGroup.id],
      ['group-created', 'group', group.id],
      ['oauth-client-approved', 'oauth-client', client.id],
      ['delegation-revoked', 'delegation', delegation.id],
      ['request-refused', 'request', claim.result.request_id ?? ''],
      ['approval-granted', 'request', approval.result.request_id ?? ''],
      ['config-changed', 'instance-config', 'telemetry'],
      ['user-deactivated', 'user', rig.seeded.bob.id],
      // Objects that are gone, or were never created: the id, no label.
      ['share-revoked', 'share', 'no-such-share'],
      ['group-created', 'group', 'no-such-group'],
      ['oauth-client-disabled', 'oauth-client', 'no-such-client'],
      ['delegation-revoked', 'delegation', 'no-such-delegation'],
      ['request-refused', 'request', 'no-such-request'],
      ['user-reactivated', 'user', 'no-such-user'],
      ['connection-revoked', 'connection', 'not-created:github'],
    ];
    const base = Date.now() + 1000;
    for (const [i, [act, type, id]] of objects.entries()) {
      await store.auditWriter.write({
        kind: 'admin',
        ts: new Date(base + i).toISOString(),
        user_id: rig.operator.id,
        act,
        object: { type, id },
        before: null,
        after: null,
        delegated_client_id: null,
      });
    }

    const entries = await search(userViewer(rig.operator, true), { kind: 'admin' });
    const labels = entries
      .flatMap((e) => (e.kind === 'admin' ? [e] : []))
      .filter((e) => Date.parse(e.ts) >= base)
      .reverse()
      .map((e) => [e.object.type, e.object.label]);
    expect(labels).toEqual([
      ['mission', 'Ship the billing page'],
      ['connection', connection.displayName],
      ['share', `${connection.displayName} → bob@example.com`],
      ['share', `${connection.displayName} → Platform`],
      ['group', 'Platform'],
      ['oauth-client', 'Desk Agent'],
      ['delegation', 'Desk Agent'],
      ['request', 'the limit of Ship the billing page'],
      ['request', 'a call of Ship the billing page'],
      ['instance-config', null],
      ['user', 'bob@example.com'],
      ['share', null],
      ['group', null],
      ['oauth-client', null],
      ['delegation', null],
      ['request', null],
      ['user', null],
      ['connection', null],
    ]);
    // Every object type has a row above: a type added to the union must be added here.
    const covered = new Set(objects.map(([, type]) => type));
    const every: Record<AdminObjectType, true> = {
      connection: true,
      share: true,
      mission: true,
      request: true,
      delegation: true,
      group: true,
      'oauth-client': true,
      user: true,
      'instance-config': true,
    };
    expect([...covered].sort()).toEqual(Object.keys(every).sort());
  });

  it('names the bootstrap operator instead of showing its actor id', async () => {
    await rig.root.store.auditWriter.write({
      kind: 'admin',
      ts: '2026-10-13T08:00:00.000Z',
      user_id: BOOTSTRAP_ACTOR_ID,
      act: 'config-changed',
      object: { type: 'instance-config', id: 'idp' },
      before: null,
      after: null,
      delegated_client_id: null,
    });
    const entries = await search(userViewer(rig.operator, true));
    const byBootstrap = entries.filter(
      (e) => e.kind === 'admin' && e.actor.id === BOOTSTRAP_ACTOR_ID,
    );
    expect(byBootstrap).toHaveLength(1);
    expect(byBootstrap[0]).toMatchObject({
      actor: { id: BOOTSTRAP_ACTOR_ID, email: null, label: BOOTSTRAP_ACTOR_LABEL },
    });
  });

  it('a filter never widens the scope', async () => {
    await seedCall(rig, mission);
    const bob = userViewer(rig.seeded.bob);
    expect(await search(bob, { missionId: mission.id })).toEqual([]);
    expect(await search(bob, { user: 'ada@example.com' })).toEqual([]);
    expect(await search(bob, { connectionId: rig.seeded.github.connection.id })).toEqual([]);
    expect(await search(bob, { kind: 'admin' })).toEqual([]);
  });

  it('a request of a mission is in the audit of that mission', async () => {
    // Exhaust the pull-request quota (2): the third call drops a claim.
    for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
    const refused = await seedCall(rig, mission, { risks: [PR] });
    if (refused.result.outcome !== 'refused' || !refused.result.request_id) {
      throw new Error('expected a claim');
    }
    // What the request service writes when the creator answers.
    await rig.root.store.auditWriter.write({
      kind: 'admin',
      ts: new Date().toISOString(),
      user_id: rig.seeded.ada.id,
      act: 'request-refused',
      object: { type: 'request', id: refused.result.request_id },
      before: { state: 'open' },
      after: { state: 'refused' },
      delegated_client_id: null,
    });

    expect(acts(await search(userViewer(rig.seeded.ada), { missionId: mission.id }))).toContain(
      'request-refused',
    );
    expect(acts(await search(userViewer(rig.seeded.bob)))).toEqual([]);
  });

  // ── Filters ───────────────────────────────────────────────────────────────

  describe('filters', () => {
    let other: MissionRecord;
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));

    beforeEach(async () => {
      other = await issueMission(rig, rig.seeded.ada, {
        name: 'Rotate the keys',
        connections: [
          { connection_id: rig.seeded.supabase.connection.id, trust_levels: { query: 'trusting' } },
        ],
        period: { kind: 'one-off' },
        expires_at: null,
      });
      await seedCall(rig, mission, { now: day(10), agentLabel: 'planner' });
      await seedCall(rig, mission, {
        now: day(11),
        tool: 'github__create_pull_request',
        risks: [PR],
      });
      await seedCall(rig, mission, {
        now: day(11),
        tool: 'github__create_pull_request',
        risks: [PR],
      });
      // Third pull request of the day: refused, budget exhausted.
      await seedCall(rig, mission, {
        now: day(11),
        tool: 'github__create_pull_request',
        risks: [PR],
      });
      await seedCall(rig, other, {
        now: day(12),
        tool: 'supabase__list_tables',
        risks: [other.policy[0]!.riskId],
        resourceRef: 'stgprojectref',
      });
    });

    const ada = () => userViewer(rig.seeded.ada);

    it('by mission: its calls and the acts on it', async () => {
      const entries = await search(ada(), { missionId: other.id });
      expect(calls(entries).map((c) => c.tool)).toEqual(['supabase__list_tables']);
      expect(acts(entries)).toEqual(['mission-issued']);
    });

    it('by connection', async () => {
      const entries = await search(ada(), { connectionId: rig.seeded.github.connection.id });
      expect(calls(entries)).toHaveLength(4);
      expect(calls(entries).every((c) => c.connection?.provider === 'github')).toBe(true);
    });

    it('by tool, exact name', async () => {
      expect(calls(await search(ada(), { tool: 'github__create_pull_request' }))).toHaveLength(3);
      expect(await search(ada(), { tool: 'github__create' })).toEqual([]);
    });

    it('by agent label, exact: the calls that declared it, and nothing administrative', async () => {
      await seedCall(rig, other, {
        now: day(12),
        tool: 'supabase__list_tables',
        risks: [other.policy[0]!.riskId],
        resourceRef: 'stgprojectref',
        agentLabel: 'planner',
      });
      const planner = await search(ada(), { agentLabel: 'planner' });
      expect(calls(planner).map((c) => [c.tool, c.agent_label])).toEqual([
        ['supabase__list_tables', 'planner'],
        ['github__get_file', 'planner'],
      ]);
      expect(acts(planner)).toEqual([]);
      // Exact, case-sensitive; a prefix is not a label.
      expect(await search(ada(), { agentLabel: 'plan' })).toEqual([]);
      expect(await search(ada(), { agentLabel: 'Planner' })).toEqual([]);
      // Narrowed by the other filters like any other.
      expect(
        calls(await search(ada(), { agentLabel: 'planner', missionId: mission.id })),
      ).toHaveLength(1);
      // A label is not a way into someone else's audit: the scope comes first.
      expect(await search(userViewer(rig.seeded.bob), { agentLabel: 'planner' })).toEqual([]);
      expect(parseAuditQuery({ agent: 'planner' }).filters.agentLabel).toBe('planner');
    });

    it('by token holder: an email names a member, anything else a named token; each call names its holder', async () => {
      const { bob } = rig.seeded;
      const seeded = (token: {
        token_id: string;
        token_kind: 'member' | 'named';
        holder: string;
      }) =>
        seedCall(rig, other, {
          now: day(12),
          tool: 'supabase__list_tables',
          risks: [other.policy[0]!.riskId],
          resourceRef: 'stgprojectref',
          token,
        });
      await seeded({ token_id: 't-bob', token_kind: 'member', holder: bob.id });
      await seeded({ token_id: 't-ci', token_kind: 'named', holder: 'CI runner' });

      const byBob = calls(await search(ada(), { tokenHolder: bob.email }));
      expect(byBob.map((c) => [c.tool, c.token])).toEqual([
        ['supabase__list_tables', { kind: 'member', key: bob.id, label: bob.email }],
      ]);
      const byCi = calls(await search(ada(), { tokenHolder: 'CI runner' }));
      expect(byCi.map((c) => c.token)).toEqual([
        { kind: 'named', key: 'CI runner', label: 'CI runner' },
      ]);
      // The exact form the session page links with.
      expect(calls(await search(ada(), { tokenHolder: `member:${bob.id}` }))).toHaveLength(1);
      expect(calls(await search(ada(), { tokenHolder: 'named:CI runner' }))).toHaveLength(1);
      // The creator's own calls are hers, by her email.
      const byAda = calls(await search(ada(), { tokenHolder: rig.seeded.ada.email }));
      expect(byAda.length).toBeGreaterThan(0);
      expect(byAda.every((c) => c.token?.label === rig.seeded.ada.email)).toBe(true);
      // Nothing administrative, nothing for an unknown holder, and a kind is never crossed:
      // a token named like a user's id is not that member.
      expect(acts(await search(ada(), { tokenHolder: bob.email }))).toEqual([]);
      expect(await search(ada(), { tokenHolder: 'nobody@example.com' })).toEqual([]);
      expect(await search(ada(), { tokenHolder: 'ci runner' })).toEqual([]);
      expect(await search(ada(), { tokenHolder: `named:${bob.id}` })).toEqual([]);
      // A holder is not a way into someone else's audit: the scope comes first.
      expect(await search(userViewer(bob), { tokenHolder: bob.email })).toEqual([]);
      expect(parseAuditQuery({ holder: 'CI runner' }).filters.tokenHolder).toBe('CI runner');
    });

    it('by decision', async () => {
      const refused = calls(await search(ada(), { decision: 'refused' }));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        refusal_code: 'budget-exhausted',
        remaining_budget: null,
        tool: 'github__create_pull_request',
      });
      expect(calls(await search(ada(), { decision: 'allowed' }))).toHaveLength(4);
      // A decision is a property of calls: administrative entries drop out.
      expect(acts(await search(ada(), { decision: 'allowed' }))).toEqual([]);
    });

    it('by kind', async () => {
      expect((await search(ada(), { kind: 'admin' })).every((e) => e.kind === 'admin')).toBe(true);
      expect(await search(ada(), { kind: 'call' })).toHaveLength(5);
    });

    it('by period: from inclusive, to exclusive, as the page parses them', async () => {
      const { filters } = parseAuditQuery({ from: '2026-10-11', to: '2026-10-11' });
      expect(calls(await search(ada(), filters))).toHaveLength(3);
      const from = parseAuditQuery({ from: '2026-10-12' }).filters;
      expect(calls(await search(ada(), from)).map((c) => c.tool)).toEqual([
        'supabase__list_tables',
      ]);
      const to = parseAuditQuery({ to: '2026-10-10' }).filters;
      expect(calls(await search(ada(), to))).toHaveLength(1);
    });

    it('by user: their acts and the calls of their missions; an unknown user matches nothing', async () => {
      const operator = userViewer(rig.operator, true);
      await configChange();
      expect(acts(await search(operator, { user: 'ops@example.com' }))).toEqual(['config-changed']);
      expect(acts(await search(operator, { user: 'ada@example.com' })).sort()).toEqual([
        'mission-issued',
        'mission-issued',
      ]);
      expect(calls(await search(ada(), { user: 'ada@example.com' }))).toHaveLength(5);
      expect(calls(await search(ada(), { user: rig.seeded.ada.id }))).toHaveLength(5);
      expect(await search(ada(), { user: 'nobody@example.com' })).toEqual([]);
    });

    it('filters combine', async () => {
      const entries = await search(ada(), {
        ...parseAuditQuery({ from: '2026-10-11', to: '2026-10-11' }).filters,
        missionId: mission.id,
        tool: 'github__create_pull_request',
        decision: 'allowed',
      });
      expect(calls(entries)).toHaveLength(2);
      expect(calls(entries).map((c) => c.remaining_budget?.[PR])).toEqual([0, 1]);
    });

    it('each call shows the remaining budget of the risks it touched', async () => {
      const [first] = calls(await search(ada(), { tool: 'github__get_file' }));
      expect(first).toMatchObject({
        risks_touched: [READ],
        remaining_budget: { [READ]: 4 },
        agent_label: 'planner',
        upstream_latency_ms: 12,
        client_ip: '203.0.113.7',
      });
    });
  });

  // ── Paging ────────────────────────────────────────────────────────────────

  it('keyset paging: newest first, no entry twice, none skipped, stable on equal timestamps', async () => {
    const same = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
    for (let i = 0; i < 4; i++) await seedCall(rig, mission, { now: same, tool: `github__t${i}` });
    for (let i = 4; i < 7; i++) {
      await seedCall(rig, mission, {
        now: new Date(same.getTime() + i * 1000),
        tool: `github__t${i}`,
      });
    }
    const viewer = userViewer(rig.seeded.ada);
    const filters = { ...NO_FILTER, kind: 'call' } as const;
    const { query } = rig.root.audit;

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await query.search(viewer, filters, cursor, 3);
      sizes.push(page.entries.length);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.next;
      if (!cursor) break;
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(new Set(seen).size).toBe(7);

    const all = await query.search(viewer, filters, null, 50);
    expect(all.next).toBeNull();
    expect(seen).toEqual(all.entries.map((e) => e.id));
    const stamps = all.entries.map((e) => e.ts);
    expect(stamps).toEqual([...stamps].sort().reverse());
    // The page that ends exactly on the last entry announces no further page.
    expect((await query.search(viewer, filters, null, 7)).next).toBeNull();
  });

  it('an entry written while paging does not shift the following pages', async () => {
    for (let i = 0; i < 4; i++) {
      await seedCall(rig, mission, { now: new Date(Date.UTC(2026, 9, 11, 9, i)) });
    }
    const viewer = userViewer(rig.seeded.ada);
    const filters = { ...NO_FILTER, kind: 'call' } as const;
    const first = await rig.root.audit.query.search(viewer, filters, null, 2);
    await seedCall(rig, mission, { now: new Date(Date.UTC(2026, 9, 11, 10, 0)) });
    const second = await rig.root.audit.query.search(viewer, filters, first.next, 2);
    expect(second.entries).toHaveLength(2);
    expect(second.entries.some((e) => first.entries.some((f) => f.id === e.id))).toBe(false);
  });

  // ── Arguments ─────────────────────────────────────────────────────────────

  it('nobody sees raw arguments: a call shows their hash only, and only to who answers for it', async () => {
    const { entry } = await seedCall(rig, mission);
    await seedCall(rig, mission, {
      tool: 'github__create_pull_request',
      risks: [PR],
      args: { title: ARGUMENT_MARKER },
    });
    for (const viewer of [userViewer(rig.seeded.ada), userViewer(rig.operator, true), BOOTSTRAP]) {
      const page = await rig.root.audit.query.search(viewer, NO_FILTER);
      expect(JSON.stringify(page)).not.toContain(ARGUMENT_MARKER);
    }
    const [call] = calls(await search(userViewer(rig.seeded.ada), { tool: 'github__get_file' }));
    expect(call?.arguments_hash).toBe(entry.arguments_hash);
    expect(call?.arguments_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(call ?? {})).not.toEqual(expect.arrayContaining(['args', 'arguments']));
  });

  it('arguments a writer wrongly put in an administrative entry are not shown', async () => {
    await rig.root.store.auditWriter.write({
      kind: 'admin',
      ts: new Date().toISOString(),
      user_id: rig.seeded.ada.id,
      act: 'approval-granted',
      object: { type: 'mission', id: mission.id },
      before: null,
      after: {
        tool: 'github__merge',
        arguments: { secret: ARGUMENT_MARKER },
        nested: [{ args: 1 }],
      },
      delegated_client_id: null,
    });
    const page = await rig.root.audit.query.search(userViewer(rig.seeded.ada), NO_FILTER);
    expect(JSON.stringify(page)).not.toContain(ARGUMENT_MARKER);
    const granted = page.entries.find((e) => e.kind === 'admin' && e.act === 'approval-granted');
    expect(granted).toMatchObject({
      after: {
        tool: 'github__merge',
        arguments: ARGUMENTS_NOT_SHOWN,
        nested: [{ args: ARGUMENTS_NOT_SHOWN }],
      },
    });
  });

  it('offers the viewer their own missions and connections as filter values', async () => {
    const options = await rig.root.audit.query.filterOptions(userViewer(rig.seeded.ada));
    expect(options.missions).toEqual([{ id: mission.id, name: 'Ship the billing page' }]);
    expect(options.connections.map((c) => c.label)).toContain('github — acme-org');
    expect(await rig.root.audit.query.filterOptions(userViewer(rig.seeded.bob))).toEqual({
      missions: [],
      connections: [],
    });
    expect(await rig.root.audit.query.filterOptions(BOOTSTRAP)).toEqual({
      missions: [],
      connections: [],
    });
  });
});
