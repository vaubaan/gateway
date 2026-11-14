/**
 * `AuthorityService` — what a user may accept in a mission on one account
 * (spec §3.1 "The chain").
 *
 * Two bases, one interface:
 *
 *   owner   the user who owns the account, or any *current* member of the
 *           group that owns it: the provider's full catalog, as an explicit
 *           enumeration. "The owner needs no share."
 *   share   everyone else: the union of the restrictions of the active shares
 *           of that account whose target is the user or one of their
 *           current groups (spec §3.1 "Union of shares"), kept to the ids the
 *           catalog still knows, in catalog order.
 *
 * Nothing is cached, in a session, in a mission or here: every answer reads
 * the user's status, their group memberships and the active shares from the
 * store (spec §10 "a user's authority on an account is recomputed from
 * their current group membership, never from a snapshot"). A user the IdP
 * removed holds nothing.
 *
 * Handbook: docs/handbook/authority.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { RiskId } from '@vaubaan/shared';

import type { AccountsRepo } from '../store/repositories/accounts';
import type { GroupsRepo } from '../store/repositories/groups';
import type { SharesRepo } from '../store/repositories/shares';
import type { UsersRepo } from '../store/repositories/users';
import type { AccountRecord, Principal } from '../store/types';
import { fullCatalogRiskIds, uncoveredRisks } from '../../lib/authority/catalog-authority';

/** Why the user holds this authority. */
export type AuthorityBasis = 'owner' | 'share' | 'none';

export interface AccountAuthority {
  readonly accountId: string;
  readonly provider: string;
  readonly basis: AuthorityBasis;
  /** Explicit enumeration, catalog order. Empty means "may accept nothing". */
  readonly riskIds: readonly RiskId[];
}

/**
 * The person acting — the session's user, a mission's creator, whoever reads
 * or answers — trusted by id only: every service that needs more (their
 * authority, their missions, their requests) reads it from the store. The one
 * type for it in missions, requests, the audit and here. Not an `Actor`
 * (accounts), which carries the user's current groups.
 */
export interface Subject {
  readonly id: string;
}

export interface AuthorityService {
  authorityOf(user: Subject, account: AccountRecord): Promise<AccountAuthority>;
  /**
   * The accounts on which the user may hold some authority — the candidates
   * of an issuance: the ones they own and the ones shared with them. Every
   * status is returned: the caller decides what an `expired` account allows.
   */
  accountsOf(user: Subject): Promise<AccountRecord[]>;
}

/** "Do these ids of this account still fall within the user's authority?" */
export interface AuthorityQuestion {
  readonly account: AccountRecord;
  readonly riskIds: readonly RiskId[];
}

/** One account on which the user no longer covers what was asked. */
export interface AuthorityGap {
  readonly accountId: string;
  /** What the user still holds there: `share` (a narrower one) or `none`. */
  readonly basis: Exclude<AuthorityBasis, 'owner'>;
  /** The ids asked that the authority does not cover, in the order asked. */
  readonly uncovered: readonly RiskId[];
}

export interface AuthorityGaps {
  /** The user is unknown or was removed from the IdP: they hold nothing anywhere. */
  readonly subjectRemoved: boolean;
  readonly gaps: readonly AuthorityGap[];
}

/**
 * A share that is not stored: "what would this user hold if it were made?". It stands
 * in place of the active share its target already holds on that account, the way
 * `SharesRepo.replaceForTarget` would store it. Only a forecast passes one; the
 * execution door never does.
 */
export interface SupposedShare {
  readonly accountId: string;
  readonly target: Principal;
  readonly restriction: readonly RiskId[];
}

/**
 * The re-check of an authority that was already granted (the execution door
 * asks it on every request, for the creator of the presented mission).
 */
export interface AuthorityRecheck {
  gapsOf(
    user: Subject,
    questions: readonly AuthorityQuestion[],
    supposing?: SupposedShare,
  ): Promise<AuthorityGaps>;
}

export interface AccountAuthorityDeps {
  readonly registry: PluginRegistry;
  readonly users: Pick<UsersRepo, 'getById'>;
  readonly groups: Pick<GroupsRepo, 'groupsOf'>;
  readonly accounts: Pick<AccountsRepo, 'listOwnedBy' | 'getById'>;
  readonly shares: Pick<SharesRepo, 'listActiveForTargets'>;
}

/** The user and their current groups, read lazily and at most once per question. */
type Principals = () => Promise<Principal[]>;

export class AccountAuthorityService implements AuthorityService, AuthorityRecheck {
  constructor(private readonly deps: AccountAuthorityDeps) {}

  async authorityOf(user: Subject, account: AccountRecord): Promise<AccountAuthority> {
    const base = { accountId: account.id, provider: account.provider };
    const none: AccountAuthority = { ...base, basis: 'none', riskIds: [] };
    const registered = this.deps.registry.get(account.provider);
    // No plugin, no catalog, no authority: nothing can be enumerated.
    if (!registered || !(await this.isActive(user))) return none;

    const catalog = fullCatalogRiskIds(registered.plugin.catalog);
    const principals = this.principalsOf(user);
    if (await this.owns(account, user, principals)) {
      return { ...base, basis: 'owner', riskIds: catalog };
    }
    const shared = await this.sharedOn(account, principals);
    if (shared === null) return none;
    // A risk the catalog dropped since the share was made cannot be accepted any more.
    const held = new Set(shared);
    return { ...base, basis: 'share', riskIds: catalog.filter((id) => held.has(id)) };
  }

  async accountsOf(user: Subject): Promise<AccountRecord[]> {
    if (!(await this.isActive(user))) return [];
    const principals = await this.principalsOf(user)();
    const owned = await this.deps.accounts.listOwnedBy(principals);
    const byId = new Map(owned.map((c) => [c.id, c]));
    for (const share of await this.deps.shares.listActiveForTargets(principals)) {
      if (byId.has(share.accountId)) continue;
      const account = await this.deps.accounts.getById(share.accountId);
      if (account) byId.set(account.id, account);
    }
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The cheap path of the hot call. An account the user owns in their own
   * name costs no read beyond the user's status; the groups are read once,
   * and only when an account is not owned in the user's name; the shares
   * only when the user is not an owner at all. No catalog is enumerated: the
   * question is whether the authority that grounded these ids vanished, not
   * whether the catalog still lists them.
   */
  async gapsOf(
    user: Subject,
    questions: readonly AuthorityQuestion[],
    supposing?: SupposedShare,
  ): Promise<AuthorityGaps> {
    if (!(await this.isActive(user))) {
      return {
        subjectRemoved: true,
        gaps: questions.map((q) => ({
          accountId: q.account.id,
          basis: 'none',
          uncovered: q.riskIds,
        })),
      };
    }
    const principals = this.principalsOf(user);
    const gaps: AuthorityGap[] = [];
    for (const { account, riskIds } of questions) {
      if (riskIds.length === 0) continue;
      if (await this.owns(account, user, principals)) continue;
      const shared = await this.sharedOn(account, principals, supposing);
      const uncovered = shared === null ? riskIds : uncoveredRisks({ riskIds: shared }, riskIds);
      if (uncovered.length === 0) continue;
      gaps.push({
        accountId: account.id,
        basis: shared === null ? 'none' : 'share',
        uncovered,
      });
    }
    return { subjectRemoved: false, gaps };
  }

  private async isActive(user: Subject): Promise<boolean> {
    const record = await this.deps.users.getById(user.id);
    return record !== null && record.status === 'active';
  }

  private principalsOf(user: Subject): Principals {
    let pending: Promise<Principal[]> | null = null;
    return () => {
      pending ??= this.deps.groups
        .groupsOf(user.id)
        .then((groups) => [
          { kind: 'user', id: user.id } satisfies Principal,
          ...groups.map((g): Principal => ({ kind: 'group', id: g.id })),
        ]);
      return pending;
    };
  }

  private async owns(
    account: AccountRecord,
    user: Subject,
    principals: Principals,
  ): Promise<boolean> {
    if (account.owner.kind === 'user') return account.owner.id === user.id;
    const ownerGroupId = account.owner.id;
    return (await principals()).some((p) => p.kind === 'group' && p.id === ownerGroupId);
  }

  /**
   * The union of the active shares of the account to the user, or `null` without any.
   * With `supposing` on this account: the stored share of the same target is left
   * out (it would be replaced) and the supposed one counts when it reaches the user.
   */
  private async sharedOn(
    account: AccountRecord,
    principals: Principals,
    supposing?: SupposedShare,
  ): Promise<RiskId[] | null> {
    const reached = await principals();
    const stored = await this.deps.shares.listActiveForTargets(reached, account.id);
    if (!supposing || supposing.accountId !== account.id) {
      if (stored.length === 0) return null;
      return stored.flatMap((share) => share.restriction);
    }
    const restrictions: (readonly RiskId[])[] = stored
      .filter((share) => !samePrincipal(share.target, supposing.target))
      .map((share) => share.restriction);
    if (reached.some((principal) => samePrincipal(principal, supposing.target))) {
      restrictions.push(supposing.restriction);
    }
    if (restrictions.length === 0) return null;
    return restrictions.flat();
  }
}

function samePrincipal(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && a.id === b.id;
}
