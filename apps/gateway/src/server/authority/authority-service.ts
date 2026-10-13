/**
 * `AuthorityService` — what a user may accept in a mission on one connection
 * (spec §3.1 "The chain").
 *
 * Two bases, one interface:
 *
 *   owner   the user who owns the connection, or any *current* member of the
 *           group that owns it: the provider's full catalog, as an explicit
 *           enumeration. "The owner needs no share."
 *   share   everyone else: the union of the restrictions of the active shares
 *           of that connection whose target is the user or one of their
 *           current groups (spec §3.1 "Union of shares"), kept to the ids the
 *           catalog still knows, in catalog order.
 *
 * Nothing is cached, in a session, in a mission or here: every answer reads
 * the user's status, their group memberships and the active shares from the
 * store (spec §10 "a user's authority on a connection is recomputed from
 * their current group membership, never from a snapshot"). A user the IdP
 * removed holds nothing.
 *
 * Handbook: docs/handbook/authority.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { RiskId } from '@vaubaan/shared';

import type { ConnectionsRepo } from '../store/repositories/connections';
import type { GroupsRepo } from '../store/repositories/groups';
import type { SharesRepo } from '../store/repositories/shares';
import type { UsersRepo } from '../store/repositories/users';
import type { ConnectionRecord, Principal } from '../store/types';
import { fullCatalogRiskIds, uncoveredRisks } from './catalog-authority';

/** Why the user holds this authority. */
export type AuthorityBasis = 'owner' | 'share' | 'none';

export interface ConnectionAuthority {
  readonly connectionId: string;
  readonly provider: string;
  readonly basis: AuthorityBasis;
  /** Explicit enumeration, catalog order. Empty means "may accept nothing". */
  readonly riskIds: readonly RiskId[];
}

/** The user whose authority is asked; only the id is read. */
export interface AuthoritySubject {
  readonly id: string;
}

export interface AuthorityService {
  authorityOf(user: AuthoritySubject, connection: ConnectionRecord): Promise<ConnectionAuthority>;
  /**
   * The connections on which the user may hold some authority — the candidates
   * of an issuance: the ones they own and the ones shared with them. Every
   * status is returned: the caller decides what an `expired` connection allows.
   */
  connectionsOf(user: AuthoritySubject): Promise<ConnectionRecord[]>;
}

/** "Do these ids of this connection still fall within the user's authority?" */
export interface AuthorityQuestion {
  readonly connection: ConnectionRecord;
  readonly riskIds: readonly RiskId[];
}

/** One connection on which the user no longer covers what was asked. */
export interface AuthorityGap {
  readonly connectionId: string;
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
 * The re-check of an authority that was already granted (the execution door
 * asks it on every request, for the creator of the presented mission).
 */
export interface AuthorityRecheck {
  gapsOf(user: AuthoritySubject, questions: readonly AuthorityQuestion[]): Promise<AuthorityGaps>;
}

export interface ConnectionAuthorityDeps {
  readonly registry: PluginRegistry;
  readonly users: Pick<UsersRepo, 'getById'>;
  readonly groups: Pick<GroupsRepo, 'groupsOf'>;
  readonly connections: Pick<ConnectionsRepo, 'listOwnedBy' | 'getById'>;
  readonly shares: Pick<SharesRepo, 'listActiveForTargets'>;
}

/** The user and their current groups, read lazily and at most once per question. */
type Principals = () => Promise<Principal[]>;

export class ConnectionAuthorityService implements AuthorityService, AuthorityRecheck {
  constructor(private readonly deps: ConnectionAuthorityDeps) {}

  async authorityOf(
    user: AuthoritySubject,
    connection: ConnectionRecord,
  ): Promise<ConnectionAuthority> {
    const base = { connectionId: connection.id, provider: connection.provider };
    const none: ConnectionAuthority = { ...base, basis: 'none', riskIds: [] };
    const registered = this.deps.registry.get(connection.provider);
    // No plugin, no catalog, no authority: nothing can be enumerated.
    if (!registered || !(await this.isActive(user))) return none;

    const catalog = fullCatalogRiskIds(registered.plugin.catalog);
    const principals = this.principalsOf(user);
    if (await this.owns(connection, user, principals)) {
      return { ...base, basis: 'owner', riskIds: catalog };
    }
    const shared = await this.sharedOn(connection, principals);
    if (shared === null) return none;
    // A risk the catalog dropped since the share was made cannot be accepted any more.
    const held = new Set(shared);
    return { ...base, basis: 'share', riskIds: catalog.filter((id) => held.has(id)) };
  }

  async connectionsOf(user: AuthoritySubject): Promise<ConnectionRecord[]> {
    if (!(await this.isActive(user))) return [];
    const principals = await this.principalsOf(user)();
    const owned = await this.deps.connections.listOwnedBy(principals);
    const byId = new Map(owned.map((c) => [c.id, c]));
    for (const share of await this.deps.shares.listActiveForTargets(principals)) {
      if (byId.has(share.connectionId)) continue;
      const connection = await this.deps.connections.getById(share.connectionId);
      if (connection) byId.set(connection.id, connection);
    }
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The cheap path of the hot call. A connection the user owns in their own
   * name costs no read beyond the user's status; the groups are read once,
   * and only when a connection is not owned in the user's name; the shares
   * only when the user is not an owner at all. No catalog is enumerated: the
   * question is whether the authority that grounded these ids vanished, not
   * whether the catalog still lists them.
   */
  async gapsOf(
    user: AuthoritySubject,
    questions: readonly AuthorityQuestion[],
  ): Promise<AuthorityGaps> {
    if (!(await this.isActive(user))) {
      return {
        subjectRemoved: true,
        gaps: questions.map((q) => ({
          connectionId: q.connection.id,
          basis: 'none',
          uncovered: q.riskIds,
        })),
      };
    }
    const principals = this.principalsOf(user);
    const gaps: AuthorityGap[] = [];
    for (const { connection, riskIds } of questions) {
      if (riskIds.length === 0) continue;
      if (await this.owns(connection, user, principals)) continue;
      const shared = await this.sharedOn(connection, principals);
      const uncovered = shared === null ? riskIds : uncoveredRisks({ riskIds: shared }, riskIds);
      if (uncovered.length === 0) continue;
      gaps.push({
        connectionId: connection.id,
        basis: shared === null ? 'none' : 'share',
        uncovered,
      });
    }
    return { subjectRemoved: false, gaps };
  }

  private async isActive(user: AuthoritySubject): Promise<boolean> {
    const record = await this.deps.users.getById(user.id);
    return record !== null && record.status === 'active';
  }

  private principalsOf(user: AuthoritySubject): Principals {
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
    connection: ConnectionRecord,
    user: AuthoritySubject,
    principals: Principals,
  ): Promise<boolean> {
    if (connection.owner.kind === 'user') return connection.owner.id === user.id;
    const ownerGroupId = connection.owner.id;
    return (await principals()).some((p) => p.kind === 'group' && p.id === ownerGroupId);
  }

  /** The union of the active shares of the connection to the user, or `null` without any. */
  private async sharedOn(
    connection: ConnectionRecord,
    principals: Principals,
  ): Promise<RiskId[] | null> {
    const shares = await this.deps.shares.listActiveForTargets(await principals(), connection.id);
    if (shares.length === 0) return null;
    return shares.flatMap((share) => share.restriction);
  }
}
