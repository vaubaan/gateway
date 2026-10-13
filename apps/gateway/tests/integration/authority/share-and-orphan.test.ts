/**
 * Shares and the `orphaned` state end to end (spec §3.1, §2.3, §7.3, §7.8;
 * §10 "Integration … share, issuance, … revocation flows, `orphaned`
 * states"), on the real composition root with the `:memory:` store: the
 * owner shares a restriction, the beneficiary issues within it, exceeding it
 * is refused with the uncovered list, and the day the authority vanishes the
 * mission is `orphaned` and every call is refused `mission-inactive`.
 */
import { REFUSAL_RPC_CODE } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShareError } from '../../../src/server/shares';
import type { RpcBody } from '../../../src/server/execution/testing';
import { NO_FILTER } from '../audit/support';
import {
  authorityRig,
  PROFILE,
  PURGE,
  READ,
  WRITE_PROD,
  WRITE_STAGING,
  type AuthorityRig,
} from './support';

function inactive(body: RpcBody): Record<string, unknown> {
  expect(body.error?.code).toBe(REFUSAL_RPC_CODE);
  expect(body.error?.data?.code).toBe('mission-inactive');
  return body.error?.data ?? {};
}

describe('share → issue within the restriction → exceed → revoke → orphaned', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  const shareToBob = async (riskIds: readonly string[]) =>
    rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'user', email: 'bob@example.com' },
      riskIds,
    });

  it('runs the whole chain: the beneficiary is bounded by R1, and loses the mission with the share', async () => {
    // Before any share, Bob holds nothing on Ada's connection.
    expect(await rig.root.missions.service.issuanceContext(rig.bob)).toEqual([]);

    // The owner shares R1.
    const shared = await shareToBob([READ, WRITE_STAGING]);
    expect(shared.share.restriction).toEqual([READ, WRITE_STAGING]);
    expect(shared.targetLabel).toBe('bob@example.com');

    // The beneficiary sees it under "Shares received", with the exact restriction.
    const received = await rig.root.shares.service.received(await rig.actor(rig.bob));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ ownerLabel: 'ada@example.com', via: 'you' });
    expect(received[0]?.risks.map((r) => r.risk_id)).toEqual([READ, WRITE_STAGING]);

    // …and issues within R1.
    const context = await rig.root.missions.service.issuanceContext(rig.bob);
    expect(context.map((c) => [c.id, c.authority])).toEqual([
      [rig.connection.id, [READ, WRITE_STAGING]],
    ]);
    const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
    expect((await rig.read(mission)).result).toBeDefined();

    // Exceeding R1 is refused at issuance, with the explicit uncovered list.
    const beyond = await rig.tryIssue(rig.bob, [READ, PURGE, WRITE_PROD]);
    expect(beyond.ok).toBe(false);
    if (beyond.ok || beyond.reason !== 'refused') throw new Error('expected a refusal');
    const exceeded = beyond.preview.issues.find((i) => i.code === 'exceeds-authority');
    expect(exceeded?.risk_ids).toEqual([PURGE, WRITE_PROD]);
    expect(beyond.preview.connections[0]?.exceeds).toEqual([PURGE, WRITE_PROD]);

    // The owner revokes the share: the mission is orphaned at once…
    const revoked = await rig.root.shares.service.revoke(await rig.actor(rig.ada), shared.share.id);
    expect(revoked).toMatchObject({ share: { status: 'revoked' }, orphaned: 1 });
    expect(await rig.statusOf(mission)).toBe('orphaned');
    const orphanEntries = await rig.adminEntries('mission-orphaned');
    expect(orphanEntries).toHaveLength(1);
    expect(orphanEntries[0]).toMatchObject({
      user_id: rig.ada.id,
      object: { type: 'mission', id: mission.mission.id },
      before: { status: 'active' },
      after: {
        status: 'orphaned',
        cause: 'authority-lost',
        connection_id: rig.connection.id,
        uncovered: [READ, WRITE_STAGING],
      },
    });

    // …and every call is refused `mission-inactive(orphaned)`, with the reason.
    const before = rig.depot.calls.length;
    const refusal = inactive(await rig.read(mission));
    expect(refusal.status).toBe('orphaned');
    expect(String(refusal.reason)).toMatch(/authority/);
    expect(String(refusal.hint)).toContain('orphaned');
    expect(rig.depot.calls).toHaveLength(before);

    const { body: listed } = await rig.rpc(mission.token, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    });
    expect(listed.error?.data).toMatchObject({ code: 'mission-inactive', status: 'orphaned' });
    const catalog = await rig.root.execution.handlers.catalog(
      new Request('https://gateway.example.com/mcp/catalog', {
        headers: { authorization: `Bearer ${mission.token}` },
      }),
    );
    expect(catalog.status).toBe(403);

    // Bob holds nothing any more, so nothing new can be issued either.
    expect(await rig.root.missions.service.issuanceContext(rig.bob)).toEqual([]);
    expect(await rig.root.shares.service.received(await rig.actor(rig.bob))).toEqual([]);
    // The owner's own missions never depended on the share.
    const owners = await rig.issueFor(rig.ada, [READ, PURGE]);
    expect((await rig.read(owners)).result).toBeDefined();
  });

  it('narrowing a share orphans only the missions that exceed the new restriction', async () => {
    await shareToBob([READ, WRITE_STAGING, PROFILE]);
    const reader = await rig.issueFor(rig.bob, [READ], 'Reader');
    const writer = await rig.issueFor(rig.bob, [READ, WRITE_STAGING], 'Writer');

    const narrowed = await shareToBob([READ, PROFILE]);
    expect(narrowed.replaced?.status).toBe('active'); // the record as it was before the replacement
    expect(narrowed.orphaned).toBe(1);

    expect(await rig.statusOf(reader)).toBe('active');
    expect(await rig.statusOf(writer)).toBe('orphaned');
    expect((await rig.read(reader)).result).toBeDefined();
    expect(inactive(await rig.read(writer)).status).toBe('orphaned');
    expect((await rig.adminEntries('mission-orphaned'))[0]?.after).toMatchObject({
      uncovered: [WRITE_STAGING],
    });
    // One active share per target: the previous one is revoked, not kept beside.
    const shares = await rig.root.store.shares.listForConnection(rig.connection.id);
    expect(shares.map((s) => s.status).sort()).toEqual(['active', 'revoked']);
  });

  it('holds the union of a direct share and a share made to a group of the user', async () => {
    const team = await rig.root.groups.service.create(rig.operator.id, 'depot-team');
    await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
    await shareToBob([READ]);
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'group', groupId: team.id },
      riskIds: [WRITE_STAGING],
    });

    const [context] = await rig.root.missions.service.issuanceContext(rig.bob);
    expect(context?.authority).toEqual([READ, WRITE_STAGING]);
    const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
    const received = await rig.root.shares.service.received(await rig.actor(rig.bob));
    expect(received.map((r) => r.via).sort()).toEqual(['group depot-team', 'you']);

    // The operator removes Bob from the group: the half the group share grounded is gone.
    const removal = await rig.root.groups.service.removeMember(
      rig.operator.id,
      team.id,
      rig.bob.id,
    );
    expect(removal.orphaned).toBe(1);
    expect(await rig.statusOf(mission)).toBe('orphaned');
    expect((await rig.adminEntries('mission-orphaned'))[0]).toMatchObject({
      user_id: rig.operator.id,
      after: { cause: 'authority-lost', uncovered: [WRITE_STAGING] },
    });
    // What the direct share still grounds can be issued again.
    expect((await rig.read(await rig.issueFor(rig.bob, [READ]))).result).toBeDefined();
  });

  it('is seen by the door itself when nobody swept: authority is never snapshotted in a mission', async () => {
    const team = await rig.root.store.groups.getOrCreate('depot-team', 'local');
    await rig.root.store.groups.addMember(team.id, rig.bob.id);
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'group', groupId: team.id },
      riskIds: [READ],
    });
    const mission = await rig.issueFor(rig.bob, [READ]);
    expect((await rig.read(mission)).result).toBeDefined();

    // The membership changes straight in the store: no service, no sweep, no event.
    await rig.root.store.groups.removeMember(team.id, rig.bob.id);
    expect(await rig.statusOf(mission)).toBe('active');

    expect(inactive(await rig.read(mission)).status).toBe('orphaned');
    expect(await rig.statusOf(mission)).toBe('orphaned');
    // No human was behind that detection: the call is audited, no admin entry names anyone.
    expect(await rig.adminEntries('mission-orphaned')).toEqual([]);
    const calls = await rig.root.store.audit.list({ missionId: mission.mission.id, kind: 'call' });
    expect(calls.at(-1)).toMatchObject({ decision: 'refused', refusal_code: 'mission-inactive' });
  });

  it('keeps an orphaned mission orphaned when the authority comes back; a new mission is issued instead', async () => {
    const first = await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);
    await rig.root.shares.service.revoke(await rig.actor(rig.ada), first.share.id);
    expect(await rig.statusOf(mission)).toBe('orphaned');

    await shareToBob([READ]);
    expect(inactive(await rig.read(mission)).status).toBe('orphaned');
    expect((await rig.read(await rig.issueFor(rig.bob, [READ]))).result).toBeDefined();
  });

  it('orphans the missions of a creator the IdP removed', async () => {
    await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);
    await rig.root.store.users.markRemoved(rig.bob.id);
    expect(inactive(await rig.read(mission)).status).toBe('orphaned');
  });

  it('orphans every mission of a connection its owner revokes, the owner’s own included', async () => {
    await shareToBob([READ]);
    const bobs = await rig.issueFor(rig.bob, [READ]);
    const adas = await rig.issueFor(rig.ada, [READ, PURGE]);

    await rig.root.connections.service.revoke(await rig.actor(rig.ada), rig.connection.id);

    expect(await rig.statusOf(bobs)).toBe('orphaned');
    expect(await rig.statusOf(adas)).toBe('orphaned');
    const entries = await rig.adminEntries('mission-orphaned');
    expect(entries.map((e) => (e.after as { cause: string }).cause)).toEqual([
      'connection-revoked',
      'connection-revoked',
    ]);
    expect(inactive(await rig.read(adas)).status).toBe('orphaned');
  });

  it('shows each side its own half in the Audit: share acts to the owner, the orphaning to the creator', async () => {
    const { share } = await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);
    await rig.root.shares.service.revoke(await rig.actor(rig.ada), share.id);

    const actsSeenBy = async (user: typeof rig.ada, isOperator = false) => {
      const { entries } = await rig.root.audit.query.search(
        { kind: 'user', user, groups: [], isOperator },
        { ...NO_FILTER },
      );
      return entries.flatMap((e) => (e.kind === 'admin' ? [`${e.act}:${e.object.id}`] : [])).sort();
    };
    // The owner of the connection: what happened to its shares.
    expect(await actsSeenBy(rig.ada)).toEqual(
      [`share-created:${share.id}`, `share-revoked:${share.id}`].sort(),
    );
    // The creator of the mission: its issuance, and why it stopped.
    expect(await actsSeenBy(rig.bob)).toEqual(
      [`mission-issued:${mission.mission.id}`, `mission-orphaned:${mission.mission.id}`].sort(),
    );
    // An operator reads every administrative act.
    expect(await actsSeenBy(rig.operator, true)).toHaveLength(4);
  });

  describe('only the owner shares (spec §11.2: no transitive sharing)', () => {
    it('answers "not found" to a beneficiary who tries to share, list or revoke', async () => {
      const { share } = await shareToBob([READ, WRITE_STAGING]);
      const bob = await rig.actor(rig.bob);
      const asBob = rig.root.shares.service;
      await expect(
        asBob.share(bob, rig.connection.id, {
          target: { kind: 'user', email: 'ops@example.com' },
          riskIds: [READ],
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      await expect(asBob.contextFor(bob, rig.connection.id)).rejects.toBeInstanceOf(ShareError);
      await expect(asBob.revoke(bob, share.id)).rejects.toMatchObject({ code: 'not-found' });
      expect((await rig.root.store.shares.getById(share.id))?.status).toBe('active');
      expect(await rig.adminEntries('share-revoked')).toEqual([]);
    });

    it('lets every current member of an owner group share', async () => {
      const admins = await rig.root.groups.service.create(rig.operator.id, 'depot-admins');
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ops@example.com');
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        admins.id,
      );
      const outcome = await rig.root.shares.service.share(
        await rig.actor(rig.operator),
        rig.connection.id,
        { target: { kind: 'user', email: 'bob@example.com' }, riskIds: [READ] },
      );
      expect(outcome.share.createdByUserId).toBe(rig.operator.id);
    });
  });
});
