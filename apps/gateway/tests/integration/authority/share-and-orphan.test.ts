/**
 * Shares and the `orphaned` state end to end (spec §3.1, §2.3, §7.3, §7.8;
 * §10 "Integration … share, issuance, … revocation flows, `orphaned`
 * states"), on the real composition root with the `:memory:` store: the
 * owner shares a restriction, the beneficiary issues within it, exceeding it
 * is refused with the uncovered list, and while the authority is missing the
 * mission is `orphaned` and every call is refused `mission-inactive`. The
 * state is derived, never stored: when the authority comes back the same
 * token serves again, with its session and counters (feature P2.2b).
 */
import { REFUSAL_RPC_CODE } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatUtc } from '../../../src/server/requests';
import { ShareError } from '../../../src/server/shares';
import { line, type RpcBody } from '../../support/execution/testing';
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
    rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
      target: { kind: 'user', email: 'bob@example.com' },
      riskIds,
    });

  it('runs the whole chain: the beneficiary is bounded by R1, and loses the mission with the share', async () => {
    // Before any share, Bob holds nothing on Ada's account.
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
      [rig.account.id, [READ, WRITE_STAGING]],
    ]);
    const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
    expect((await rig.read(mission)).result).toBeDefined();

    // Exceeding R1 is refused at issuance, with the explicit uncovered list.
    const beyond = await rig.tryIssue(rig.bob, [READ, PURGE, WRITE_PROD]);
    expect(beyond.ok).toBe(false);
    if (beyond.ok || beyond.reason !== 'refused') throw new Error('expected a refusal');
    const exceeded = beyond.preview.issues.find((i) => i.code === 'exceeds-authority');
    expect(exceeded?.risk_ids).toEqual([PURGE, WRITE_PROD]);
    expect(beyond.preview.accounts[0]?.exceeds).toEqual([PURGE, WRITE_PROD]);

    // The owner revokes the share: the mission is orphaned at once…
    const revoked = await rig.root.shares.service.revoke(
      await rig.actor(rig.ada),
      shared.share.id,
      shared.share.accountId,
    );
    expect(revoked).toMatchObject({ share: { status: 'revoked' }, orphaned: 1 });
    expect(await rig.statusOf(mission)).toBe('orphaned');
    // …as a derived state: the store still holds `active`.
    expect(await rig.storedStatusOf(mission)).toBe('active');
    const orphanEntries = await rig.adminEntries('mission-orphaned');
    expect(orphanEntries).toHaveLength(1);
    expect(orphanEntries[0]).toMatchObject({
      user_id: rig.ada.id,
      object: { type: 'mission', id: mission.mission.id },
      before: { status: 'active' },
      after: {
        status: 'orphaned',
        cause: 'authority-lost',
        account_id: rig.account.id,
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
    const shares = await rig.root.store.shares.listForAccount(rig.account.id);
    expect(shares.map((s) => s.status).sort()).toEqual(['active', 'revoked']);
  });

  it('holds the union of a direct share and a share made to a group of the user', async () => {
    const team = await rig.root.groups.service.create(rig.operator.id, 'depot-team');
    await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
    await shareToBob([READ]);
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
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

  it('is seen by the door itself when nobody watched: authority is never snapshotted in a mission', async () => {
    const team = await rig.root.store.groups.getOrCreate('depot-team', 'local', null);
    await rig.root.store.groups.addMember(team.id, rig.bob.id);
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
      target: { kind: 'group', groupId: team.id },
      riskIds: [READ],
    });
    const mission = await rig.issueFor(rig.bob, [READ]);
    expect((await rig.read(mission)).result).toBeDefined();

    // The membership changes straight in the store: no service, no watch, no event.
    await rig.root.store.groups.removeMember(team.id, rig.bob.id);

    // Every reader derives the state at once: the door, and the creator's page.
    expect(inactive(await rig.read(mission)).status).toBe('orphaned');
    expect(await rig.statusOf(mission)).toBe('orphaned');
    expect(await rig.storedStatusOf(mission)).toBe('active');
    // No human was behind that detection: the call is audited, no admin entry names anyone.
    expect(await rig.adminEntries('mission-orphaned')).toEqual([]);
    const calls = await rig.root.store.audit.list({ missionId: mission.mission.id, kind: 'call' });
    expect(calls.at(-1)).toMatchObject({ decision: 'refused', refusal_code: 'mission-inactive' });
  });

  describe('`orphaned` is derived and reversible (spec §2.3)', () => {
    /** The session and its counters, as the store holds them. */
    const sessionOf = async (mission: { mission: { id: string } }) => {
      const session = await rig.root.store.sessions.getByMission(mission.mission.id);
      if (!session) throw new Error('the mission has no session yet');
      const counters = await rig.root.store.sessions.counters(session.id);
      return {
        id: session.id,
        createdAt: session.createdAt,
        consumed: Object.fromEntries(counters.map((c) => [c.riskId, c.consumed])),
      };
    };

    it('lose → refused → regain: the same token serves the next call, with the same session and counters', async () => {
      const first = await shareToBob([READ]);
      const mission = await rig.issueFor(rig.bob, [READ]);
      expect((await rig.read(mission)).result).toBeDefined();
      expect((await rig.read(mission)).result).toBeDefined();
      const before = await sessionOf(mission);
      expect(before.consumed).toEqual({ [READ]: 2 });

      // Lost: the owner revokes the share.
      const revoked = await rig.root.shares.service.revoke(
        await rig.actor(rig.ada),
        first.share.id,
        first.share.accountId,
      );
      expect(revoked.orphaned).toBe(1);
      expect(await rig.statusOf(mission)).toBe('orphaned');
      const upstream = rig.depot.calls.length;
      expect(inactive(await rig.read(mission)).status).toBe('orphaned');
      expect(inactive(await rig.read(mission)).status).toBe('orphaned');
      expect(rig.depot.calls).toHaveLength(upstream);
      // A refused call consumes nothing and the verdict was written nowhere.
      expect(await sessionOf(mission)).toEqual(before);
      expect(await rig.storedStatusOf(mission)).toBe('active');

      // Regained: the owner shares again.
      const again = await shareToBob([READ]);
      expect(again).toMatchObject({ replaced: null, orphaned: 0, restored: 1 });
      expect(await rig.statusOf(mission)).toBe('active');

      // The very same Bearer, the very same session, the counters where they were.
      expect((await rig.read(mission)).result).toBeDefined();
      expect(rig.depot.calls).toHaveLength(upstream + 1);
      const after = await sessionOf(mission);
      expect(after.id).toBe(before.id);
      expect(after.createdAt).toBe(before.createdAt);
      expect(after.consumed).toEqual({ [READ]: 3 });
      const tokens = await rig.root.store.missions.listTokens(mission.mission.id);
      expect(tokens.map((t) => [t.prefix, t.status])).toEqual([[mission.prefix, 'active']]);

      // Both human acts are in the audit, each with its author; the calls between them too.
      expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
        { user_id: rig.ada.id, object: { id: mission.mission.id } },
      ]);
      expect(await rig.adminEntries('mission-restored')).toMatchObject([
        {
          user_id: rig.ada.id,
          object: { type: 'mission', id: mission.mission.id },
          before: {
            status: 'orphaned',
            cause: 'authority-lost',
            account_id: rig.account.id,
            uncovered: [READ],
          },
          after: { status: 'active' },
        },
      ]);
      const calls = await rig.root.store.audit.list({
        missionId: mission.mission.id,
        kind: 'call',
      });
      expect(calls.map((e) => (e.kind === 'call' ? e.decision : e.kind))).toEqual([
        'allowed',
        'allowed',
        'refused',
        'refused',
        'allowed',
      ]);
    });

    it('is restored only when the new share covers every accepted risk of the mission', async () => {
      const first = await shareToBob([READ, WRITE_STAGING]);
      const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
      await rig.root.shares.service.revoke(
        await rig.actor(rig.ada),
        first.share.id,
        first.share.accountId,
      );

      // Narrower than what the mission accepted: still orphaned, and it says why.
      expect(await shareToBob([READ])).toMatchObject({ restored: 0 });
      expect(inactive(await rig.read(mission)).status).toBe('orphaned');
      const detail = await rig.root.missions.service.get(rig.bob, mission.mission.id);
      expect(detail?.orphan).toEqual({
        cause: 'authority-lost',
        account_id: rig.account.id,
        uncovered: [WRITE_STAGING],
      });

      expect(await shareToBob([READ, WRITE_STAGING])).toMatchObject({ restored: 1 });
      expect((await rig.read(mission)).result).toBeDefined();
      expect((await rig.root.missions.service.get(rig.bob, mission.mission.id))?.orphan).toBeNull();
    });

    it('is detected by the door in both directions without any administrative entry', async () => {
      const team = await rig.root.store.groups.getOrCreate('depot-team', 'local', null);
      await rig.root.store.groups.addMember(team.id, rig.bob.id);
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
        target: { kind: 'group', groupId: team.id },
        riskIds: [READ],
      });
      const mission = await rig.issueFor(rig.bob, [READ]);
      expect((await rig.read(mission)).result).toBeDefined();

      // The membership goes and comes back straight in the store: no service, no watch.
      await rig.root.store.groups.removeMember(team.id, rig.bob.id);
      expect(inactive(await rig.read(mission)).status).toBe('orphaned');
      await rig.root.store.groups.addMember(team.id, rig.bob.id);
      expect((await rig.read(mission)).result).toBeDefined();

      expect(await rig.adminEntries('mission-orphaned')).toEqual([]);
      expect(await rig.adminEntries('mission-restored')).toEqual([]);
      expect(await rig.storedStatusOf(mission)).toBe('active');
    });

    it('a group membership the operator returns restores the missions it grounded', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'depot-team');
      await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
        target: { kind: 'group', groupId: team.id },
        riskIds: [READ],
      });
      const mission = await rig.issueFor(rig.bob, [READ]);

      await rig.root.groups.service.removeMember(rig.operator.id, team.id, rig.bob.id);
      expect(inactive(await rig.read(mission)).status).toBe('orphaned');

      const added = await rig.root.groups.service.addMember(
        rig.operator.id,
        team.id,
        'bob@example.com',
      );
      expect(added.restored).toBe(1);
      expect((await rig.read(mission)).result).toBeDefined();
      expect(await rig.adminEntries('mission-restored')).toMatchObject([
        { user_id: rig.operator.id, object: { id: mission.mission.id } },
      ]);
    });

    it('a revoked account never comes back: its missions stay orphaned whatever is shared afterwards', async () => {
      await shareToBob([READ]);
      const bobs = await rig.issueFor(rig.bob, [READ]);
      const adas = await rig.issueFor(rig.ada, [READ]);
      await rig.root.accounts.service.revoke(await rig.actor(rig.ada), rig.account.id);

      // The service refuses to share a revoked account…
      await expect(shareToBob([READ, PURGE])).rejects.toMatchObject({
        code: 'account-revoked',
      });
      // …and a share written behind its back grounds nothing either.
      await rig.root.store.shares.create({
        accountId: rig.account.id,
        target: { kind: 'user', id: rig.bob.id },
        restriction: [READ, PURGE],
        createdByUserId: rig.ada.id,
      });
      for (const mission of [bobs, adas]) {
        expect(inactive(await rig.read(mission)).status).toBe('orphaned');
        expect(await rig.statusOf(mission)).toBe('orphaned');
      }
      const detail = await rig.root.missions.service.get(rig.bob, bobs.mission.id);
      expect(detail?.orphan).toMatchObject({
        cause: 'account-revoked',
        account_id: rig.account.id,
      });
      expect(await rig.adminEntries('mission-restored')).toEqual([]);
    });

    it('a revoked mission and an expired mission are unaffected by the authority coming or going', async () => {
      const first = await shareToBob([READ]);
      const revokedMission = await rig.issueFor(rig.bob, [READ], 'Revoked');
      const expiredMission = await rig.issueFor(rig.bob, [READ], 'Expired');
      await rig.root.missions.service.revoke(rig.bob, revokedMission.mission.id);
      await rig.root.store.missions.setStatus(expiredMission.mission.id, 'expired');

      await rig.root.shares.service.revoke(
        await rig.actor(rig.ada),
        first.share.id,
        first.share.accountId,
      );
      expect(await rig.statusOf(revokedMission)).toBe('revoked');
      expect(await rig.statusOf(expiredMission)).toBe('expired');
      expect(inactive(await rig.read(expiredMission)).status).toBe('expired');

      expect(await shareToBob([READ])).toMatchObject({ restored: 0 });
      expect(await rig.statusOf(revokedMission)).toBe('revoked');
      expect(inactive(await rig.read(revokedMission)).status).toBe('revoked');
      expect(inactive(await rig.read(expiredMission)).status).toBe('expired');
      // Neither was ever orphaned or restored: no entry names them.
      expect(await rig.adminEntries('mission-orphaned')).toEqual([]);
      expect(await rig.adminEntries('mission-restored')).toEqual([]);
    });

    it('while orphaned: no gate edit, no rotation, no decision on a claim; all of them are back with the authority', async () => {
      const first = await shareToBob([READ]);
      const mission = await rig.issueFor(rig.bob, [READ], 'Tight', (id) => line(id, 1));
      expect((await rig.read(mission)).result).toBeDefined();
      // The quota is spent: the next call opens a claim.
      const exhausted = await rig.read(mission);
      expect(exhausted.error?.data?.code).toBe('budget-exhausted');
      const [claim] = await rig.root.requests.service.inbox(rig.bob);
      if (!claim) throw new Error('expected an open claim');

      await rig.root.shares.service.revoke(
        await rig.actor(rig.ada),
        first.share.id,
        first.share.accountId,
      );
      const { service } = rig.root.missions;
      expect(await service.setGate(rig.bob, mission.mission.id, READ, 'approval')).toEqual({
        ok: false,
        reason: 'inactive',
        state: 'orphaned',
      });
      expect(await service.rotate(rig.bob, mission.mission.id)).toEqual({
        ok: false,
        reason: 'inactive',
        state: 'orphaned',
      });
      const viewed = await rig.root.requests.service.view(rig.bob, claim.id);
      if (viewed.outcome !== 'ok' || viewed.view.kind !== 'claim') {
        throw new Error('expected the claim view');
      }
      const { view } = viewed;
      expect(view.mission.state).toBe('orphaned');
      expect(view.options.find((o) => o.resolution === 'reset-period')?.unavailable).toEqual({
        code: 'mission-closed',
        message: expect.stringContaining('orphaned') as string,
      });
      expect(
        await rig.root.requests.service.decide(rig.bob, claim.id, { resolution: 'reset-period' }),
      ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'mission-closed' } });

      // The authority is back: the same claim is granted, and the mission serves again.
      await shareToBob([READ]);
      expect(
        await rig.root.requests.service.decide(rig.bob, claim.id, { resolution: 'reset-period' }),
      ).toMatchObject({ ok: true });
      expect((await rig.read(mission)).result).toBeDefined();
      expect(await service.setGate(rig.bob, mission.mission.id, READ, 'approval')).toMatchObject({
        ok: true,
        gate: 'approval',
      });
    });
  });

  it('lets the creator close an orphaned mission for good: no gate edit, the creator revokes', async () => {
    const { share } = await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);
    await rig.root.shares.service.revoke(await rig.actor(rig.ada), share.id, share.accountId);

    const { service } = rig.root.missions;
    expect(await service.setGate(rig.bob, mission.mission.id, READ, 'approval')).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'orphaned',
    });
    expect(await service.revoke(rig.bob, mission.mission.id)).toMatchObject({
      ok: true,
      mission: { status: 'revoked' },
    });
    expect(inactive(await rig.read(mission)).status).toBe('revoked');
    expect(await rig.storedStatusOf(mission)).toBe('revoked');
    // Revoked is stored and terminal: the authority coming back changes nothing.
    expect(await shareToBob([READ])).toMatchObject({ restored: 0 });
    expect(await rig.statusOf(mission)).toBe('revoked');
  });

  it('orphans the missions of a creator the IdP removed', async () => {
    await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);
    await rig.root.store.users.markRemoved(rig.bob.id);
    expect(inactive(await rig.read(mission)).status).toBe('orphaned');
  });

  it('orphans every mission of an account its owner revokes, the owner’s own included', async () => {
    await shareToBob([READ]);
    const bobs = await rig.issueFor(rig.bob, [READ]);
    const adas = await rig.issueFor(rig.ada, [READ, PURGE]);

    await rig.root.accounts.service.revoke(await rig.actor(rig.ada), rig.account.id);

    expect(await rig.statusOf(bobs)).toBe('orphaned');
    expect(await rig.statusOf(adas)).toBe('orphaned');
    const entries = await rig.adminEntries('mission-orphaned');
    expect(entries.map((e) => (e.after as { cause: string }).cause)).toEqual([
      'account-revoked',
      'account-revoked',
    ]);
    expect(inactive(await rig.read(adas)).status).toBe('orphaned');
  });

  it('shows each side its own half in the Audit: share acts to the owner, the orphaning to the creator', async () => {
    const { share } = await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);
    await rig.root.shares.service.revoke(await rig.actor(rig.ada), share.id, share.accountId);

    const actsSeenBy = async (user: typeof rig.ada, isOperator = false) => {
      const { entries } = await rig.root.audit.query.search(
        { kind: 'user', user, groups: [], isOperator },
        { ...NO_FILTER },
      );
      return entries.flatMap((e) => (e.kind === 'admin' ? [`${e.act}:${e.object.id}`] : [])).sort();
    };
    // The owner of the account: what happened to its shares.
    expect(await actsSeenBy(rig.ada)).toEqual(
      [`share-created:${share.id}`, `share-revoked:${share.id}`].sort(),
    );
    // The creator of the mission: its issuance, and why it stopped.
    expect(await actsSeenBy(rig.bob)).toEqual(
      [`mission-issued:${mission.mission.id}`, `mission-orphaned:${mission.mission.id}`].sort(),
    );
    // An operator reads every administrative act (the boot's `administrators-seeded` included).
    expect(await actsSeenBy(rig.operator, true)).toHaveLength(5);
  });

  describe('only the owner shares (spec §11.2: no transitive sharing)', () => {
    it('answers "not found" to a beneficiary who tries to share, list or revoke', async () => {
      const { share } = await shareToBob([READ, WRITE_STAGING]);
      const bob = await rig.actor(rig.bob);
      const asBob = rig.root.shares.service;
      await expect(
        asBob.share(bob, rig.account.id, {
          target: { kind: 'user', email: 'ops@example.com' },
          riskIds: [READ],
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      await expect(asBob.contextFor(bob, rig.account.id)).rejects.toBeInstanceOf(ShareError);
      await expect(asBob.revoke(bob, share.id, share.accountId)).rejects.toMatchObject({
        code: 'not-found',
      });
      expect(
        (await rig.root.store.shares.get({ accountId: share.accountId, shareId: share.id }))
          ?.status,
      ).toBe('active');
      expect(await rig.adminEntries('share-revoked')).toEqual([]);
    });

    it('lets every current member of an owner group share', async () => {
      const admins = await rig.root.groups.service.create(rig.operator.id, 'depot-admins');
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ops@example.com');
      await rig.root.accounts.service.transfer(await rig.actor(rig.ada), rig.account.id, admins.id);
      const outcome = await rig.root.shares.service.share(
        await rig.actor(rig.operator),
        rig.account.id,
        { target: { kind: 'user', email: 'bob@example.com' }, riskIds: [READ] },
      );
      expect(outcome.share.createdByUserId).toBe(rig.operator.id);
    });
  });
});

/**
 * A request does not wait for the authority (handbook requests, Traps, "A request of
 * an orphaned mission still expires"): its clock keeps running while the mission reads
 * `orphaned`, the sweeper expires it on the normal `requests.expiry` delay and erases
 * its sealed arguments, and once the authority is back the executor's next refused
 * call opens a new one.
 */
describe('a request on an orphaned mission still expires on the normal delay', () => {
  const EXPIRY_MS = 10 * 60_000;
  let rig: AuthorityRig;

  beforeEach(async () => {
    // The instance runs on the system clock: only `Date` is faked, timers stay real.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T09:00:00.000Z') });
    rig = await authorityRig({ env: { VAUBAAN_REQUEST_EXPIRY: '10m' } });
  });
  afterEach(async () => {
    await rig.close();
    vi.useRealTimers();
  });

  const shareToBob = async (riskIds: readonly string[]) =>
    rig.root.shares.service.share(await rig.actor(rig.ada), rig.account.id, {
      target: { kind: 'user', email: 'bob@example.com' },
      riskIds,
    });
  const requestEvents = async (missionId: string) => {
    const session = await rig.root.store.sessions.getByMission(missionId);
    if (!session) return [];
    return (await rig.root.store.sessions.listEvents(session.id, { kinds: ['request'] })).map(
      (event) => event.details,
    );
  };

  it('a claim: orphaned, swept past its expiry, not-open once the authority is back, and the replay opens a new one', async () => {
    const first = await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ], 'Tight', (id) => line(id, 1));
    expect((await rig.read(mission)).result).toBeDefined();
    expect((await rig.read(mission)).error?.data?.code).toBe('budget-exhausted');
    const [claim] = await rig.root.requests.service.inbox(rig.bob);
    if (!claim) throw new Error('expected an open claim');

    await rig.root.shares.service.revoke(
      await rig.actor(rig.ada),
      first.share.id,
      first.share.accountId,
    );
    // The page states the limit: the request can be granted until it expires.
    const viewed = await rig.root.requests.service.view(rig.bob, claim.id);
    if (viewed.outcome !== 'ok' || viewed.view.kind !== 'claim') throw new Error('claim view');
    expect(viewed.view.mission.state).toBe('orphaned');
    expect(
      viewed.view.options.find((o) => o.resolution === 'reset-period')?.unavailable?.message,
    ).toContain(`until it expires (${formatUtc(claim.expires_at)})`);

    // Nothing pauses the request: the sweeper expires it on the normal delay.
    vi.setSystemTime(Date.now() + EXPIRY_MS - 1_000);
    expect(await rig.root.requests.service.sweep()).toBe(0);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await rig.statusOf(mission)).toBe('orphaned');
    expect(await rig.root.requests.service.sweep()).toBe(1);
    expect((await rig.root.store.requests.getById(claim.id))?.state).toBe('expired');
    expect(await requestEvents(mission.mission.id)).toContainEqual({
      request_id: claim.id,
      request_kind: 'claim',
      state: 'expired',
    });

    // The authority is back: the expired claim is not granted any more…
    expect(await shareToBob([READ])).toMatchObject({ restored: 1 });
    expect(
      await rig.root.requests.service.decide(rig.bob, claim.id, { resolution: 'reset-period' }),
    ).toEqual({ ok: false, reason: 'not-open', state: 'expired' });
    expect(await rig.root.requests.service.inbox(rig.bob)).toEqual([]);

    // …and the executor's next refused call opens a new one, which is.
    expect((await rig.read(mission)).error?.data?.code).toBe('budget-exhausted');
    const [again] = await rig.root.requests.service.inbox(rig.bob);
    expect(again?.id).toBeDefined();
    expect(again?.id).not.toBe(claim.id);
    expect(
      await rig.root.requests.service.decide(rig.bob, again?.id ?? '', {
        resolution: 'reset-period',
      }),
    ).toMatchObject({ ok: true });
    expect((await rig.read(mission)).result).toBeDefined();
  });

  it('an approval request: its sealed arguments are erased at the expiry, never held until the authority returns', async () => {
    const first = await shareToBob([PURGE]);
    const mission = await rig.issueFor(rig.bob, [PURGE], 'Gated', (id) =>
      line(id, 5, { gate: 'approval' }),
    );
    const purge = () => rig.call(mission, 'depot__purge', { space: 'scratch' });
    const blobOf = (id: string) =>
      rig.root.store.db
        .prepare<[string], { args_blob: Buffer | null }>(
          'SELECT args_blob FROM requests WHERE id = ?',
        )
        .get(id)?.args_blob;

    expect((await purge()).error?.data?.code).toBe('approval-required');
    const [request] = await rig.root.requests.service.inbox(rig.bob);
    if (!request) throw new Error('expected an open approval request');
    expect(blobOf(request.id)).toBeInstanceOf(Buffer);

    await rig.root.shares.service.revoke(
      await rig.actor(rig.ada),
      first.share.id,
      first.share.accountId,
    );
    expect((await purge()).error?.data).toMatchObject({
      code: 'mission-inactive',
      status: 'orphaned',
    });
    // While orphaned and open: only a refusal can be recorded, and the page says until when.
    const viewed = await rig.root.requests.service.view(rig.bob, request.id);
    if (viewed.outcome !== 'ok' || viewed.view.kind !== 'approval')
      throw new Error('approval view');
    expect(viewed.view.mission.state).toBe('orphaned');
    expect(viewed.view.call.arguments).toEqual({ space: 'scratch' });
    expect(viewed.view.options.filter((o) => !o.unavailable).map((o) => o.resolution)).toEqual([
      'refuse',
    ]);
    expect(
      viewed.view.options.find((o) => o.resolution === 'grant')?.unavailable?.message,
    ).toContain(`until it expires (${formatUtc(request.expires_at)})`);
    expect(
      await rig.root.requests.service.decide(rig.bob, request.id, { resolution: 'grant' }),
    ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'mission-closed' } });
    expect(blobOf(request.id)).toBeInstanceOf(Buffer);

    // Past the expiry the sweeper erases the arguments, orphaned mission or not (spec §3.5).
    vi.setSystemTime(Date.now() + EXPIRY_MS + 1_000);
    expect(await rig.statusOf(mission)).toBe('orphaned');
    expect(await rig.root.requests.service.sweep()).toBe(1);
    expect(await rig.root.store.requests.getById(request.id)).toMatchObject({
      state: 'expired',
      hasArguments: false,
    });
    expect(blobOf(request.id)).toBeNull();
    expect(await requestEvents(mission.mission.id)).toContainEqual({
      request_id: request.id,
      request_kind: 'approval',
      state: 'expired',
    });

    // The authority is back: nothing is left to grant on the expired request…
    expect(await shareToBob([PURGE])).toMatchObject({ restored: 1 });
    expect(
      await rig.root.requests.service.decide(rig.bob, request.id, { resolution: 'grant' }),
    ).toEqual({ ok: false, reason: 'not-open', state: 'expired' });
    expect(await rig.root.store.approvals.getByRequest(request.id)).toBeNull();

    // …the replay is refused again and opens a new request, which is granted and consumed.
    expect((await purge()).error?.data?.code).toBe('approval-required');
    const [again] = await rig.root.requests.service.inbox(rig.bob);
    expect(again?.id).toBeDefined();
    expect(again?.id).not.toBe(request.id);
    expect(
      await rig.root.requests.service.decide(rig.bob, again?.id ?? '', { resolution: 'grant' }),
    ).toMatchObject({ ok: true });
    expect((await purge()).result).toBeDefined();
  });
});
