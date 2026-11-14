/**
 * The rules a page shows a control on are the rules the service refuses on
 * (handbook web-app, Invariants, "Everything that decides is under `src/server/`"). Each
 * rule is stated once, next to the act it guards, and the page reads it from
 * the view it already loads. These tests tie the two ends: what the reader
 * says and what the act then answers, on the same state.
 *
 *   - a revoked or unowned account takes no owner act
 *       `ownerActRefusal` → `ShareContext.unshareable`, `transferTargets`
 *   - the gates of a revoked or orphaned mission are not edited
 *       `gateEditBlockedBy` → `MissionDetail.gates_editable`
 *   - a group without member is not named owner
 *       `AccountService.reassignTargets`
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ownerActRefusal } from '../../../src/server/accounts';
import { gateEditBlockedBy } from '../../../src/server/missions/mission-service';
import { unshareableReason } from '../../../src/server/shares';
import { MISSION_STATUSES } from '../../../src/server/store/repositories/enums';
import type { AccountRecord, GroupRecord } from '../../../src/server/store/types';
import { authorityRig, READ, type AuthorityRig } from './support';

type AccountStatus = AccountRecord['status'];

/** Keyed by status: a new account status fails to compile until it is listed here. */
const EVERY_ACCOUNT_STATUS: Readonly<Record<AccountStatus, true>> = {
  active: true,
  expired: true,
  revoked: true,
  unowned: true,
};
const ACCOUNT_STATUSES = Object.keys(EVERY_ACCOUNT_STATUS) as AccountStatus[];

describe('the predicates, on every status', () => {
  it('an account takes no owner act once revoked or unowned, and only then', () => {
    const refused = Object.fromEntries(
      ACCOUNT_STATUSES.map((status) => [status, ownerActRefusal({ status, metadata: null })]),
    );
    expect(refused).toEqual({
      active: null,
      expired: null,
      revoked: 'account-revoked',
      unowned: 'account-unowned',
    });
    // The share codes are the account's own.
    for (const status of ACCOUNT_STATUSES) {
      expect(unshareableReason({ status, metadata: null })).toBe(
        ownerActRefusal({ status, metadata: null }),
      );
    }
  });

  it('a host account (the Vaubaan account) takes no owner act while it serves: it is its person’s own', () => {
    const host = { credential_kind: 'host' };
    expect(ownerActRefusal({ status: 'active', metadata: host })).toBe('account-personal');
    expect(unshareableReason({ status: 'active', metadata: host })).toBe('account-personal');
    // Revoked is final first.
    expect(ownerActRefusal({ status: 'revoked', metadata: host })).toBe('account-revoked');
  });

  it('the gates of a mission are not edited once it is revoked or orphaned, and only then', () => {
    const blocked = Object.fromEntries(
      MISSION_STATUSES.map((status) => [status, gateEditBlockedBy({ status })]),
    );
    expect(blocked).toEqual({
      active: null,
      // An expired mission serves again once its creator extends the expiry (a claim's
      // `extend-expiry`): its gates stay theirs to set meanwhile.
      expired: null,
      orphaned: 'orphaned',
      revoked: 'revoked',
    });
  });
});

describe('what the page reads is what the act answers', () => {
  let rig: AuthorityRig;
  let admins: GroupRecord;

  beforeEach(async () => {
    rig = await authorityRig();
    admins = await rig.root.groups.service.create(rig.operator.id, 'depot-admins');
    await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
  });
  afterEach(async () => {
    await rig.close();
  });

  const ada = () => rig.actor(rig.ada);
  const account = async () => (await rig.root.store.accounts.getById(rig.account.id))!;
  const toBob = { target: { kind: 'user', email: 'bob@example.com' }, riskIds: [READ] } as const;

  it('an owned account: shareable, and transferable to the groups of its owner', async () => {
    const { accounts, shares } = rig.root;
    expect((await shares.service.contextFor(await ada(), rig.account.id)).unshareable).toBeNull();
    expect(accounts.service.transferTargets(await ada(), await account()).map((g) => g.id)).toEqual(
      [admins.id],
    );
    await expect(shares.service.share(await ada(), rig.account.id, toBob)).resolves.toBeDefined();
    await expect(
      accounts.service.transfer(await ada(), rig.account.id, admins.id),
    ).resolves.toMatchObject({ owner: { kind: 'group', id: admins.id } });
  });

  it('an unowned account: the context names the refusal of share, and no transfer target is offered', async () => {
    const { accounts, groups, shares } = rig.root;
    const others = await groups.service.create(rig.operator.id, 'others');
    await groups.service.addMember(rig.operator.id, others.id, 'ada@example.com');
    await accounts.service.transfer(await ada(), rig.account.id, admins.id);
    await groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);
    // Ada joins the emptied owner group again: she reads the account, which stays unowned.
    await groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
    expect((await account()).status).toBe('unowned');

    const context = await shares.service.contextFor(await ada(), rig.account.id);
    expect(context.unshareable).toBe('account-unowned');
    await expect(shares.service.share(await ada(), rig.account.id, toBob)).rejects.toMatchObject({
      code: context.unshareable,
    });
    // She belongs to another group, yet it is not offered: `transfer` would refuse it.
    expect(accounts.service.transferTargets(await ada(), await account())).toEqual([]);
    await expect(
      accounts.service.transfer(await ada(), rig.account.id, others.id),
    ).rejects.toMatchObject({ code: 'account-unowned' });
  });

  it('a revoked account: the same, with the revoked code', async () => {
    const { accounts, shares } = rig.root;
    await accounts.service.revoke(await ada(), rig.account.id);

    const context = await shares.service.contextFor(await ada(), rig.account.id);
    expect(context.unshareable).toBe('account-revoked');
    await expect(shares.service.share(await ada(), rig.account.id, toBob)).rejects.toMatchObject({
      code: context.unshareable,
    });
    expect(accounts.service.transferTargets(await ada(), await account())).toEqual([]);
    await expect(
      accounts.service.transfer(await ada(), rig.account.id, admins.id),
    ).rejects.toMatchObject({ code: 'account-revoked' });
  });

  it('reassignTargets lists the groups reassign accepts: the ones that have a member', async () => {
    const { accounts, groups } = rig.root;
    const empty = await groups.service.create(rig.operator.id, 'empty');
    const staffed = await groups.service.create(rig.operator.id, 'staffed');
    await groups.service.addMember(rig.operator.id, staffed.id, 'bob@example.com');
    await accounts.service.transfer(await ada(), rig.account.id, admins.id);
    await groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);

    // `depot-admins` just emptied: it is not offered either.
    const targets = await accounts.service.reassignTargets();
    expect(targets.map((g) => g.name)).toEqual(['staffed']);
    for (const refused of [empty, admins]) {
      await expect(
        accounts.service.reassign(rig.operator.id, rig.account.id, {
          kind: 'group',
          groupId: refused.id,
        }),
      ).rejects.toMatchObject({ code: 'owner-group-empty' });
    }
    await expect(
      accounts.service.reassign(rig.operator.id, rig.account.id, {
        kind: 'group',
        groupId: targets[0]!.id,
      }),
    ).resolves.toMatchObject({ status: 'active', owner: { kind: 'group', id: staffed.id } });
  });

  it('gates_editable follows setGate: off while the mission is orphaned, back with the authority, off for good once revoked', async () => {
    const { missions, shares } = rig.root;
    const { share } = await shares.service.share(await ada(), rig.account.id, toBob);
    const issued = await rig.issueFor(rig.bob, [READ]);
    const editable = async () =>
      (await missions.service.get(rig.bob, issued.mission.id))?.gates_editable;
    const setGate = (gate: string) =>
      missions.service.setGate(rig.bob, issued.mission.id, READ, gate);

    expect(await editable()).toBe(true);
    expect(await setGate('approval')).toMatchObject({ ok: true });

    await shares.service.revoke(await ada(), share.id, share.accountId);
    expect(await editable()).toBe(false);
    expect(await setGate('auto')).toEqual({ ok: false, reason: 'inactive', state: 'orphaned' });

    await shares.service.share(await ada(), rig.account.id, toBob);
    expect(await editable()).toBe(true);
    expect(await setGate('auto')).toMatchObject({ ok: true });

    await missions.service.revoke(rig.bob, issued.mission.id);
    expect(await editable()).toBe(false);
    expect(await setGate('approval')).toEqual({ ok: false, reason: 'inactive', state: 'revoked' });
  });
});
