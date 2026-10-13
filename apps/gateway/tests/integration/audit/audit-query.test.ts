/**
 * `AuditQueryService` on an ephemeral instance (spec §4.2 "Audit", §8):
 * the visibility rule, every filter, keyset paging, and "nobody sees raw
 * arguments". Calls are seeded through `SessionService.recordCall` and the
 * store's audit writer (see `support.ts`); administrative entries come from
 * the real services.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARGUMENTS_NOT_SHOWN,
  parseAuditQuery,
  type AuditCallView,
  type AuditEntryView,
  type AuditFilters,
  type AuditViewer,
} from '../../../src/server/audit';
import { seedConnection } from '../../../src/server/missions/testing';
import type { MissionRecord } from '../../../src/server/store/types';
import {
  ARGUMENT_MARKER,
  issueMission,
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
    // What a share will allow (P2.2): Ada's mission calls through Bob's connection.
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
    expect(calls(await search(userViewer(rig.operator, true)))).toEqual([]);
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
    expect(acts(await search(userViewer(rig.operator, true))).sort()).toEqual([
      'config-changed',
      'mission-issued',
      'resource-edited',
    ]);
    // An operator still does not browse the calls of other people's missions.
    await seedCall(rig, mission);
    expect(calls(await search(userViewer(rig.operator, true)))).toEqual([]);
    // The bootstrap operator owns nothing and sees the administrative entries.
    expect(acts(await search(BOOTSTRAP)).sort()).toEqual([
      'config-changed',
      'mission-issued',
      'resource-edited',
    ]);
    expect(calls(await search(BOOTSTRAP))).toEqual([]);
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
      actor: { email: 'ops@example.com' },
      object: { type: 'instance-config', id: 'idp', label: null },
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
    // What P1.7 will write when the creator answers.
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
          { connection_id: rig.seeded.supabase.connection.id, preset: 'read-only-analyst' },
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

  it('nobody sees raw arguments: a call shows their hash only', async () => {
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
