/**
 * `AuthorityService` — what a user may accept in a mission on one connection
 * (spec §3.1 "The chain").
 *
 * v5 phase 1 knows one basis: **ownership**. The owner of a connection — the
 * user who owns it, or any current member of the group that owns it — holds
 * the provider's full catalog, as an explicit enumeration, and "needs no
 * share". Everyone else holds nothing. Shares (P2.2) plug in behind the same
 * interface: a second implementation unions the restrictions of the active
 * shares targeting the user or their groups, and no caller changes.
 *
 * The authority is recomputed on every call from the current group
 * membership (spec §10 "authority recomputed from current membership"); it is
 * never cached in a session or a mission.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { RiskId } from '@vaubaan/shared';

import type { ConnectionsRepo } from '../store/repositories/connections';
import type { GroupsRepo } from '../store/repositories/groups';
import type { ConnectionRecord, Principal } from '../store/types';
import { fullCatalogRiskIds } from './catalog-authority';

/** Why the user holds this authority. `share` arrives with P2.2. */
export type AuthorityBasis = 'owner' | 'none';

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
   * of an issuance. Owned connections today; shared ones join with P2.2. Every
   * status is returned: the caller decides what an `expired` connection allows.
   */
  connectionsOf(user: AuthoritySubject): Promise<ConnectionRecord[]>;
}

export interface OwnerAuthorityDeps {
  readonly registry: PluginRegistry;
  readonly groups: Pick<GroupsRepo, 'groupsOf'>;
  readonly connections: Pick<ConnectionsRepo, 'listOwnedBy'>;
}

export class OwnerAuthorityService implements AuthorityService {
  constructor(private readonly deps: OwnerAuthorityDeps) {}

  async authorityOf(
    user: AuthoritySubject,
    connection: ConnectionRecord,
  ): Promise<ConnectionAuthority> {
    const base = { connectionId: connection.id, provider: connection.provider };
    const registered = this.deps.registry.get(connection.provider);
    // No plugin, no catalog, no authority: nothing can be enumerated.
    if (!registered || !(await this.isOwner(user, connection))) {
      return { ...base, basis: 'none', riskIds: [] };
    }
    return { ...base, basis: 'owner', riskIds: fullCatalogRiskIds(registered.plugin.catalog) };
  }

  async connectionsOf(user: AuthoritySubject): Promise<ConnectionRecord[]> {
    const groups = await this.deps.groups.groupsOf(user.id);
    const principals: Principal[] = [
      { kind: 'user', id: user.id },
      ...groups.map((g): Principal => ({ kind: 'group', id: g.id })),
    ];
    return this.deps.connections.listOwnedBy(principals);
  }

  private async isOwner(user: AuthoritySubject, connection: ConnectionRecord): Promise<boolean> {
    if (connection.owner.kind === 'user') return connection.owner.id === user.id;
    const groups = await this.deps.groups.groupsOf(user.id);
    return groups.some((g) => g.id === connection.owner.id);
  }
}

/** The ids of `requested` the authority does not cover, in request order (spec §3.1 "Monotonicity"). */
export function uncoveredRisks(
  authority: Pick<ConnectionAuthority, 'riskIds'>,
  requested: readonly RiskId[],
): RiskId[] {
  const held = new Set(authority.riskIds);
  return requested.filter((id) => !held.has(id));
}
