/**
 * Who holds an account, and its end (spec §2.3, §7.2): the owner revokes it or transfers
 * it to a group they belong to; the operator hands an ownerless one to a new owner
 * (`reassign`, the operator's only act on the domain). The account service delegates
 * these acts here and lends ownership (`AccountOwnershipHost`).
 */
import { findActiveUserByEmail } from '../authority';
import type { AccountRecord, GroupRecord, Principal } from '../store/types';
import { auditAccountAct } from './account-audit';
import type { AccountServiceDeps, Actor, NewOwner } from './account-views';
import { ConnectError } from './errors';
import { isHostAccount } from './host-account';

/**
 * Why this account takes no owner act (share, transfer, reconnect), or `null` when it
 * does (spec §2.3): revocation is final, and nobody acts on an account without owner
 * until the operator reassigns one. A `host` account (the Vaubaan account) takes none
 * either: it is its person's own, never shared nor transferred, and holds nothing to
 * reconnect (ADR platform-management-is-a-plugin-on-the-execution-door). The one
 * statement of the rule: the service's own refusals, the shares service and the pages
 * (through `transferTargets` and `ShareContext.unshareable`) all read it here.
 */
export function ownerActRefusal(
  account: Pick<AccountRecord, 'status' | 'metadata'>,
): 'account-revoked' | 'account-unowned' | 'account-personal' | null {
  if (account.status === 'revoked') return 'account-revoked';
  if (account.status === 'unowned') return 'account-unowned';
  if (isHostAccount(account)) return 'account-personal';
  return null;
}

/** What the ownership acts read of the account service: an account the actor owns. */
export interface AccountOwnershipHost {
  requireOwned(actor: Actor, accountId: string): Promise<AccountRecord>;
}

export class AccountOwnership {
  constructor(
    private readonly deps: AccountServiceDeps,
    private readonly host: AccountOwnershipHost,
  ) {}

  // ── Revoke ────────────────────────────────────────────────────────────────

  /**
   * Terminal. The sealed credential is erased, and the missions that carry
   * the account lose their part on it for good: they keep serving through
   * their other accounts, and one with no other part left is `orphaned`
   * and stays so — a revoked account never comes back (spec §2.3, §7.8; ADR
   * orphaned-missions-and-ownerless-connections, amendment 2026-10-21).
   *
   * The grant at the service is withdrawn too when the service documents
   * how (`CredentialBroker.withdrawAtService`). In this order, on purpose:
   * the credential is read, the account is revoked here, and only then is
   * the service asked — the local revocation never waits for the service
   * and never depends on its answer. What the service answered is stored on
   * the account (`serviceGrant`) and written in the entry, so that a
   * grant that still stands stays visible until somebody removes it by hand.
   */
  async revoke(actor: Actor, accountId: string): Promise<AccountRecord> {
    const account = await this.host.requireOwned(actor, accountId);
    if (account.status === 'revoked') return account;
    const watch = await this.deps.grounds.watchAccount(account.id);
    // Read before the erase: the service's endpoint wants the token the store is about to drop.
    const held = await this.deps.broker.forRevocation(account.id);
    let revoked = await this.deps.store.accounts.revoke(account.id);
    const serviceGrant = await this.deps.broker.withdrawAtService(revoked, held);
    try {
      revoked =
        (await this.deps.store.accounts.recordServiceGrant(revoked.id, serviceGrant)) ?? revoked;
    } catch (err) {
      // The revocation stands and the entry below still says what the service answered.
      this.deps.logger.error('service grant outcome not stored', {
        account_id: revoked.id,
        service_grant: serviceGrant,
        error_class: err instanceof Error ? err.name : typeof err,
      });
    }
    // Settled whatever happens to the act's own entry: the revocation is committed, and
    // the entries that say which missions stopped serving must not depend on it.
    try {
      await auditAccountAct(
        this.deps,
        actor.user.id,
        'account-revoked',
        revoked,
        { status: account.status },
        { service_grant: serviceGrant },
      );
    } finally {
      await watch.settle(actor.user.id);
    }
    this.deps.logger.info('account revoked', {
      account_id: revoked.id,
      service: revoked.service,
      user_id: actor.user.id,
      service_grant: serviceGrant,
    });
    return revoked;
  }

  // ── Ownership ─────────────────────────────────────────────────────────────

  /**
   * The groups the actor may hand this account to: the ones they belong to
   * now, the current owner group excepted (spec §11.2: never a group one is
   * not a member of). None for an account that takes no owner act, which
   * `transfer` refuses.
   */
  transferTargets(actor: Actor, account: AccountRecord): GroupRecord[] {
    if (ownerActRefusal(account)) return [];
    return actor.groups.filter(
      (g) => !(account.owner.kind === 'group' && account.owner.id === g.id),
    );
  }

  /**
   * Transfers ownership to a group the actor belongs to (spec §7.2): every
   * current and future member of that group is then a full owner. Shares of
   * the account are kept. Members of a previous owner group who are not in
   * the new one lose their authority, members of the new one gain it: the
   * missions of the account are watched across the transfer.
   */
  async transfer(actor: Actor, accountId: string, groupId: string): Promise<AccountRecord> {
    const account = await this.host.requireOwned(actor, accountId);
    const refusal = ownerActRefusal(account);
    if (refusal) throw new ConnectError(refusal);
    const group = actor.groups.find((g) => g.id === groupId);
    if (!group) throw new ConnectError('transfer-not-member');
    if (account.owner.kind === 'group' && account.owner.id === group.id) return account;

    const watch = await this.deps.grounds.watchAccount(account.id);
    const transferred = await this.deps.store.accounts.transferOwner(account.id, {
      kind: 'group',
      id: group.id,
    });
    try {
      await auditAccountAct(this.deps, actor.user.id, 'account-transferred', transferred, {
        owner: account.owner,
      });
    } finally {
      await watch.settle(actor.user.id);
    }
    this.deps.logger.info('account transferred', {
      account_id: transferred.id,
      group_id: group.id,
      user_id: actor.user.id,
    });
    return transferred;
  }

  /**
   * Operator only (the caller authorizes; `operatorId` is the audit actor):
   * gives an ownerless account a new owner. An `unowned` account is
   * `active` again; an `expired` one stays `expired` until its new owner
   * reconnects. Nothing else of the account is reachable from here: no
   * credential, no share, no mission. The missions the emptied owner group
   * had left orphaned serve again when their creator is the new owner, or a
   * member of the new owner group.
   *
   * The rule "only an account that has no owner left" is enforced by the
   * write itself (`AccountsRepo.assignOwnerlessTo`, one transaction with
   * the "new owner group has a member" check). The reads before it only
   * choose which refusal is named first; a member who joins the owner group,
   * or the last one who leaves the new group, while this method awaits is
   * seen by the write and the reassignment is refused.
   */
  async reassign(
    operatorId: string,
    accountId: string,
    newOwner: NewOwner,
  ): Promise<AccountRecord> {
    const { accounts } = this.deps.store;
    const seen = await accounts.getById(accountId);
    if (!seen) throw new ConnectError('not-found');
    // A host account is its person's own: it is never handed to anyone else.
    if (isHostAccount(seen)) throw new ConnectError('account-personal');
    if (!(await this.looksOwnerless(seen))) throw new ConnectError('not-ownerless');
    const owner = await this.resolveNewOwner(newOwner);
    const watch = await this.deps.grounds.watchAccount(seen.id);
    const result = await accounts.assignOwnerlessTo(seen.id, owner);
    // Refused at the write: nothing changed, so there is nothing to settle.
    if (result.outcome !== 'assigned') throw new ConnectError(result.outcome);
    const { previous, account: reassigned } = result;
    try {
      await auditAccountAct(this.deps, operatorId, 'account-reassigned', reassigned, {
        owner: previous.owner,
        status: previous.status,
      });
    } finally {
      await watch.settle(operatorId);
    }
    this.deps.logger.info('account reassigned by the operator', {
      account_id: reassigned.id,
      owner_kind: owner.kind,
      owner_id: owner.id,
    });
    return reassigned;
  }

  /**
   * Operator: the groups `reassign` would accept as the new owner — the ones that
   * have a member (an empty group would leave the account ownerless again).
   * A reading for the form; the write checks again in its own transaction.
   */
  async reassignTargets(): Promise<GroupRecord[]> {
    const groups = await this.deps.store.groups.list();
    const accepted = await Promise.all(groups.map((group) => this.canOwn(group)));
    return groups.filter((_, index) => accepted[index]);
  }

  /** A group can be named owner while it has a member. */
  private async canOwn(group: GroupRecord): Promise<boolean> {
    return (await this.deps.store.groups.memberCount(group.id)) > 0;
  }

  /**
   * The repository's ownerless predicate, read outside any transaction: good
   * enough to name the refusal, never to authorize the write.
   */
  private async looksOwnerless(account: AccountRecord): Promise<boolean> {
    if (account.status === 'unowned') return true;
    if (account.status === 'revoked') return false;
    if (account.owner.kind === 'user') {
      // An owner the operator deactivated holds nothing: the account is ownerless.
      const owner = await this.deps.store.users.getById(account.owner.id);
      return owner?.status !== 'active';
    }
    return (await this.deps.store.groups.memberCount(account.owner.id)) === 0;
  }

  private async resolveNewOwner(newOwner: NewOwner): Promise<Principal> {
    if (newOwner.kind === 'user') {
      const lookup = await findActiveUserByEmail(this.deps.store.users, newOwner.email);
      if (!lookup.found) throw new ConnectError('owner-unknown');
      return { kind: 'user', id: lookup.user.id };
    }
    const group = await this.deps.store.groups.getById(newOwner.groupId);
    if (!group || !(await this.canOwn(group))) {
      throw new ConnectError('owner-group-empty');
    }
    return { kind: 'group', id: group.id };
  }
}
