/**
 * Shares (spec §0 "Share", "Restriction"; §2.3; §3.1; §7.3; §7.8).
 *
 * A share is `(connection, target, restriction)`: the owner of a connection
 * grants a user or a group the right to accept, in their missions, a subset
 * of an explicit list of `RiskId`s of the provider's catalog.
 *
 * Rules held here (spec §11.2 v1 assumptions):
 *
 *   - only an owner shares (no transitive sharing): every write starts from
 *     `ConnectionService.get(actor, …)`, which answers "not found" to anyone
 *     who does not own the connection now;
 *   - a restriction carries risks only: no quantity, no gate, no resource;
 *   - never a wildcard: the ids are checked one by one against the provider's
 *     catalog, and an empty list is refused rather than stored;
 *   - one active share per `(connection, target)`: sharing again to the same
 *     target replaces the previous restriction (that is how it is edited);
 *   - a share that is revoked or narrowed leaves the missions it grounded
 *     `orphaned`, at once; a share made again brings them back. The state
 *     is derived (`MissionGrounds`): this service only watches the missions
 *     of the connection around its act, so that each change is audited.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { RiskId } from '@vaubaan/shared';

import { findActiveUserByEmail, principalLabel, type MissionGrounds } from '../authority';
import { ConnectError, type Actor, type ConnectionService } from '../connections';
import type { Logger } from '../logging';
import { enumerateCatalog } from '../missions/catalog-view';
import type { CatalogRisk } from '../missions/model';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  GroupRecord,
  Principal,
  ShareRecord,
} from '../store/types';
import { ShareError } from './errors';
import type { EnvLabelling } from './restriction';

/** Who a share is made to, as the owner names them: a user by email, or a group. */
export type ShareTargetInput =
  | { readonly kind: 'user'; readonly email: string }
  | { readonly kind: 'group'; readonly groupId: string };

export interface ShareInput {
  readonly target: ShareTargetInput;
  /** Explicit ids, as ticked. Never "all". */
  readonly riskIds: readonly RiskId[];
}

export interface ShareView {
  readonly share: ShareRecord;
  readonly targetLabel: string;
}

/** What the Share dialog of one connection needs. */
export interface ShareContext {
  readonly connection: ConnectionRecord;
  readonly providerLabel: string;
  /** The whole catalog as explicit ids, catalog order. */
  readonly risks: readonly CatalogRisk[];
  /** Every group of the instance: a share may target any of them. */
  readonly groups: readonly GroupRecord[];
  readonly labelling: EnvLabelling;
  /** The active shares of the connection. */
  readonly shares: readonly ShareView[];
}

export interface ShareOutcome {
  readonly share: ShareRecord;
  readonly targetLabel: string;
  /** The share this one replaced, when the target already held one. */
  readonly replaced: ShareRecord | null;
  /** Missions that lost their grounds because the restriction shrank. */
  readonly orphaned: number;
  /** Orphaned missions this share grounds again: they serve calls from now on. */
  readonly restored: number;
}

export interface RevokeOutcome {
  readonly share: ShareRecord;
  readonly targetLabel: string;
  readonly orphaned: number;
}

/** One risk of a received restriction; `known` is false when the catalog dropped it since. */
export interface ReceivedRisk {
  readonly risk_id: RiskId;
  readonly label: string;
  readonly level: CatalogRisk['level'] | null;
  readonly known: boolean;
}

export interface ReceivedShare {
  readonly share: ShareRecord;
  readonly connection: Pick<ConnectionRecord, 'id' | 'displayName' | 'provider' | 'status'>;
  readonly providerLabel: string;
  readonly ownerLabel: string;
  /** How it reaches the user: `you`, or the group it was made to. */
  readonly via: string;
  /** The exact restriction, catalog order. */
  readonly risks: readonly ReceivedRisk[];
}

export interface ShareServiceDeps {
  readonly store: Pick<Store, 'shares' | 'connections' | 'users' | 'groups'>;
  readonly registry: PluginRegistry;
  readonly connections: Pick<ConnectionService, 'get'>;
  readonly grounds: Pick<MissionGrounds, 'watchConnection'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  /** Owner only. The catalog, the possible group targets, the current shares. */
  async contextFor(actor: Actor, connectionId: string): Promise<ShareContext> {
    const detail = await this.owned(actor, connectionId);
    const { connection } = detail;
    const registered = this.deps.registry.get(connection.provider);
    const shares = (await this.deps.store.shares.listForConnection(connection.id)).filter(
      (share) => share.status === 'active',
    );
    return {
      connection,
      providerLabel: detail.providerLabel,
      risks: registered ? enumerateCatalog(registered.plugin.catalog) : [],
      groups: await this.deps.store.groups.list(),
      labelling: labellingOf(detail.resources, typeof registered?.plugin.envOf === 'function'),
      shares: await Promise.all(shares.map((share) => this.view(share))),
    };
  }

  /**
   * Shares the connection to a target, or replaces the restriction the target
   * already holds. Refused on a connection that is revoked or has no owner
   * (spec §2.3: "nobody can share … until the operator reassigns an owner").
   */
  async share(actor: Actor, connectionId: string, input: ShareInput): Promise<ShareOutcome> {
    const { connection } = await this.owned(actor, connectionId);
    if (connection.status === 'revoked') throw new ShareError('connection-revoked');
    if (connection.status === 'unowned') throw new ShareError('connection-unowned');
    const restriction = this.restrictionOf(connection, input.riskIds);
    const target = await this.targetOf(connection, input.target);

    const watch = await this.deps.grounds.watchConnection(connection.id);
    const { created, replaced } = await this.deps.store.shares.replaceForTarget({
      connectionId: connection.id,
      target,
      restriction,
      createdByUserId: actor.user.id,
    });
    if (replaced) await this.auditRevoked(actor, replaced, { replaced_by: created.id });
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'share-created',
      object: { type: 'share', id: created.id },
      before: replaced ? { share_id: replaced.id, restriction: replaced.restriction } : null,
      after: {
        connection_id: connection.id,
        target: created.target,
        restriction: created.restriction,
      },
      delegated_client_id: null,
    });
    // A replacement may have narrowed the restriction under missions already issued;
    // a share made again may ground missions that an earlier revocation orphaned.
    const { orphaned, restored } = await watch.settle(actor.user.id);
    this.deps.logger.info('connection shared', {
      connection_id: connection.id,
      share_id: created.id,
      target_kind: target.kind,
      risks: created.restriction.length,
      replaced: replaced?.id ?? null,
      missions_orphaned: orphaned.length,
      missions_restored: restored.length,
    });
    return {
      share: created,
      targetLabel: await principalLabel(this.deps.store, created.target),
      replaced,
      orphaned: orphaned.length,
      restored: restored.length,
    };
  }

  /**
   * Terminal for the share (spec §2.3). The missions it grounded read
   * `orphaned` until a new share covers them again.
   */
  async revoke(actor: Actor, shareId: string): Promise<RevokeOutcome> {
    const share = await this.deps.store.shares.getById(shareId);
    if (!share) throw new ShareError('not-found');
    await this.owned(actor, share.connectionId);
    const targetLabel = await principalLabel(this.deps.store, share.target);
    if (share.status === 'revoked') return { share, targetLabel, orphaned: 0 };

    const watch = await this.deps.grounds.watchConnection(share.connectionId);
    const revoked = await this.deps.store.shares.revoke(share.id);
    await this.auditRevoked(actor, share, null);
    const { orphaned } = await watch.settle(actor.user.id);
    this.deps.logger.info('share revoked', {
      connection_id: share.connectionId,
      share_id: share.id,
      missions_orphaned: orphaned.length,
    });
    return { share: revoked, targetLabel, orphaned: orphaned.length };
  }

  /**
   * "Shares received" (spec §4.2): the active shares made to the user or to a
   * group they belong to now, each with its exact restriction.
   */
  async received(actor: Actor): Promise<ReceivedShare[]> {
    const principals: Principal[] = [
      { kind: 'user', id: actor.user.id },
      ...actor.groups.map((g): Principal => ({ kind: 'group', id: g.id })),
    ];
    const received: ReceivedShare[] = [];
    for (const share of await this.deps.store.shares.listActiveForTargets(principals)) {
      const connection = await this.deps.store.connections.getById(share.connectionId);
      if (!connection) continue;
      const registered = this.deps.registry.get(connection.provider);
      const rows = registered ? enumerateCatalog(registered.plugin.catalog) : [];
      received.push({
        share,
        connection,
        providerLabel: registered?.plugin.displayName ?? connection.provider,
        ownerLabel: await principalLabel(this.deps.store, connection.owner),
        via:
          share.target.kind === 'user'
            ? 'you'
            : await principalLabel(this.deps.store, share.target),
        risks: receivedRisks(share.restriction, rows),
      });
    }
    return received;
  }

  /** The connection when the actor owns it now; anyone else reads "not found". */
  private async owned(actor: Actor, connectionId: string) {
    try {
      return await this.deps.connections.get(actor, connectionId);
    } catch (err) {
      if (err instanceof ConnectError && err.code === 'not-found')
        throw new ShareError('not-found');
      throw err;
    }
  }

  /** The ids as a restriction: non-empty, each one an explicit id of the provider's catalog. */
  private restrictionOf(connection: ConnectionRecord, riskIds: readonly RiskId[]): RiskId[] {
    const registered = this.deps.registry.get(connection.provider);
    if (!registered) throw new ShareError('provider-unknown');
    const asked = [...new Set(riskIds)];
    if (asked.length === 0) throw new ShareError('restriction-empty');
    const catalog = enumerateCatalog(registered.plugin.catalog).map((risk) => risk.risk_id);
    const known = new Set(catalog);
    const unknown = asked.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new ShareError('risk-unknown', unknown.join(', '));
    const chosen = new Set(asked);
    return catalog.filter((id) => chosen.has(id));
  }

  private async targetOf(
    connection: ConnectionRecord,
    input: ShareTargetInput,
  ): Promise<Principal> {
    let target: Principal;
    if (input.kind === 'user') {
      const lookup = await findActiveUserByEmail(this.deps.store.users, input.email);
      if (!lookup.found) {
        throw new ShareError(lookup.reason === 'unknown' ? 'target-unknown' : 'target-ambiguous');
      }
      target = { kind: 'user', id: lookup.user.id };
    } else {
      const group = await this.deps.store.groups.getById(input.groupId);
      if (!group) throw new ShareError('target-unknown');
      target = { kind: 'group', id: group.id };
    }
    // The owner holds the full catalog already: a share to the owner would grant nothing.
    if (target.kind === connection.owner.kind && target.id === connection.owner.id) {
      throw new ShareError('target-is-owner');
    }
    return target;
  }

  private async view(share: ShareRecord): Promise<ShareView> {
    return { share, targetLabel: await principalLabel(this.deps.store, share.target) };
  }

  private async auditRevoked(
    actor: Actor,
    share: ShareRecord,
    extra: Record<string, unknown> | null,
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'share-revoked',
      object: { type: 'share', id: share.id },
      before: {
        connection_id: share.connectionId,
        target: share.target,
        restriction: share.restriction,
      },
      after: { status: 'revoked', ...extra },
      delegated_client_id: null,
    });
  }

  private nowIso(): string {
    return toIso(this.deps.clock.now());
  }
}

/** What the reachable resources of a connection say about environments. */
export function labellingOf(
  resources: readonly Pick<ConnectionResourceRecord, 'env' | 'staleSince'>[],
  derivesEnv: boolean,
): EnvLabelling {
  const reachable = resources.filter((resource) => resource.staleSince === null);
  return {
    derivesEnv,
    labelledEnvs: [
      ...new Set(reachable.flatMap((resource) => (resource.env === null ? [] : [resource.env]))),
    ].sort(),
    unlabelledResources: reachable.filter((resource) => resource.env === null).length,
  };
}

function receivedRisks(
  restriction: readonly RiskId[],
  rows: readonly CatalogRisk[],
): ReceivedRisk[] {
  const held = new Set(restriction);
  const known = rows
    .filter((row) => held.has(row.risk_id))
    .map((row) => ({ risk_id: row.risk_id, label: row.label, level: row.level, known: true }));
  const listed = new Set(known.map((risk) => risk.risk_id));
  const dropped = restriction
    .filter((id) => !listed.has(id))
    .map((id) => ({ risk_id: id, label: id, level: null, known: false }));
  return [...known, ...dropped];
}
