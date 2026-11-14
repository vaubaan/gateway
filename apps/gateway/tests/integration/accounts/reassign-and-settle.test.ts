/**
 * Two guarantees of the acts on an account that hold at the write, not at a
 * read some awaits earlier (spec §2.3, §7.8):
 *
 *   - the operator's reassignment only ever lands on an account that is
 *     ownerless at the instant of the write, and on an owner group that has a
 *     member at that instant (`AccountsRepo.assignOwnerlessTo`);
 *   - the missions an act orphans are recorded even when the act's own audit
 *     entry cannot be written (`watch.settle` in a `finally`).
 *
 * The interleavings are produced by hooking the one await that sits between
 * the service's checks and its write (`MissionGrounds.watchAccount`).
 */
import type { AuditEntry } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupRecord } from '../../../src/server/store/types';
import { authorityRig, READ, type AuthorityRig } from '../authority/support';

describe('the operator reassigns only what is ownerless at the write', () => {
  let rig: AuthorityRig;
  let admins: GroupRecord;

  beforeEach(async () => {
    rig = await authorityRig();
    const { service } = rig.root.groups;
    admins = await service.create(rig.operator.id, 'depot-admins');
    await service.addMember(rig.operator.id, admins.id, 'ada@example.com');
    await rig.root.accounts.service.transfer(await rig.actor(rig.ada), rig.account.id, admins.id);
    // The last member leaves: the account is `unowned`.
    await service.removeMember(rig.operator.id, admins.id, rig.ada.id);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rig.close();
  });

  /** Runs `act` once, between the service's checks and its write. */
  function betweenCheckAndWrite(act: () => Promise<unknown>): void {
    const { grounds } = rig.root.authority;
    const watchAccount = grounds.watchAccount.bind(grounds);
    vi.spyOn(grounds, 'watchAccount').mockImplementationOnce(async (accountId) => {
      await act();
      return watchAccount(accountId);
    });
  }

  const account = async () => (await rig.root.store.accounts.getById(rig.account.id))!;
  const reassign = (
    owner: Parameters<AuthorityRig['root']['accounts']['service']['reassign']>[2],
  ) => rig.root.accounts.service.reassign(rig.operator.id, rig.account.id, owner);

  it('refuses when a member joined the owner group of an expired account meanwhile', async () => {
    // Expired and ownerless: reassignable only because its owner group is empty.
    await expect(rig.root.accounts.credentials.refresh(rig.account.id)).rejects.toBeDefined();
    expect((await account()).status).toBe('expired');
    betweenCheckAndWrite(() =>
      rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com'),
    );

    await expect(reassign({ kind: 'user', email: 'bob@example.com' })).rejects.toMatchObject({
      code: 'not-ownerless',
    });
    // The account has an owner again and the operator did not take it.
    expect(await account()).toMatchObject({
      status: 'expired',
      owner: { kind: 'group', id: admins.id },
    });
    expect(await rig.adminEntries('account-reassigned')).toEqual([]);
  });

  it('refuses when the new owner group lost its last member meanwhile', async () => {
    const { service } = rig.root.groups;
    const others = await service.create(rig.operator.id, 'others');
    await service.addMember(rig.operator.id, others.id, 'bob@example.com');
    betweenCheckAndWrite(() => service.removeMember(rig.operator.id, others.id, rig.bob.id));

    await expect(reassign({ kind: 'group', groupId: others.id })).rejects.toMatchObject({
      code: 'owner-group-empty',
    });
    // Still ownerless under its emptied group: never `active` under an empty one.
    expect(await account()).toMatchObject({
      status: 'unowned',
      owner: { kind: 'group', id: admins.id },
    });
    expect(await rig.adminEntries('account-reassigned')).toEqual([]);
  });

  it('records the owner and the status read inside the write as the `before` of the entry', async () => {
    const reassigned = await reassign({ kind: 'user', email: 'bob@example.com' });
    expect(reassigned).toMatchObject({ status: 'active', owner: { kind: 'user', id: rig.bob.id } });
    expect(await rig.adminEntries('account-reassigned')).toMatchObject([
      {
        user_id: rig.operator.id,
        before: { owner: { kind: 'group', id: admins.id }, status: 'unowned' },
        after: { status: 'active', owner: { kind: 'user', id: rig.bob.id } },
      },
    ]);
  });
});

describe('AccountsRepo.assignOwnerlessTo', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('writes nothing on an account that has an owner, or one that is revoked', async () => {
    const { accounts } = rig.root.store;
    const toBob = { kind: 'user', id: rig.bob.id } as const;
    expect(await accounts.assignOwnerlessTo(rig.account.id, toBob)).toEqual({
      outcome: 'not-ownerless',
    });
    expect((await accounts.getById(rig.account.id))?.owner).toEqual({
      kind: 'user',
      id: rig.ada.id,
    });

    await accounts.revoke(rig.account.id);
    expect(await accounts.assignOwnerlessTo(rig.account.id, toBob)).toEqual({
      outcome: 'not-ownerless',
    });
    await expect(accounts.assignOwnerlessTo('nope', toBob)).rejects.toThrow(/nope/);
  });
});

describe('the missions an act orphans are recorded whatever happens to the entry of the act', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rig.close();
  });

  it('a revocation whose own audit entry fails still writes `mission-orphaned`', async () => {
    const mission = await rig.issueFor(rig.ada, [READ]);
    const writer = rig.root.store.auditWriter;
    const write = writer.write.bind(writer);
    vi.spyOn(writer, 'write').mockImplementation(async (entry: AuditEntry) => {
      if (entry.kind === 'admin' && entry.act === 'account-revoked') {
        throw new Error('the audit store refused the write');
      }
      return write(entry);
    });

    await expect(
      rig.root.accounts.service.revoke(await rig.actor(rig.ada), rig.account.id),
    ).rejects.toThrow(/refused the write/);

    // The revocation is committed, and the audit says why the mission stopped serving.
    expect((await rig.root.store.accounts.getById(rig.account.id))?.status).toBe('revoked');
    expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
      { object: { type: 'mission', id: mission.mission.id } },
    ]);
    expect(await rig.statusOf(mission)).toBe('orphaned');
  });
});
