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
 *   - never to someone who owns the connection now — its owner, or a current
 *     member of the group that owns it: such a share grants nothing today and
 *     would only outlive the membership (see
 *     docs/spec/vaubaan-gateway.md);
 *   - one active share per `(connection, target)`: sharing again to the same
 *     target replaces the previous restriction (that is how it is edited);
 *   - a share that is revoked or narrowed leaves the missions it grounded
 *     `orphaned`, at once; a share made again brings them back. The state
 *     is derived (`MissionGrounds`): this service only watches the missions
 *     of the connection around its act, so that each change is audited;
 *   - a share that would bring orphaned missions back names them first
 *     (`forecast`): the dialog lists them and the owner confirms that list
 *     (spec §2.3; `handlers.ts` holds the confirmation).
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import { type PluginRegistry, type ServiceIcon, serviceIconOf } from '@vaubaan/plugin-sdk';
import type { RiskId } from '@vaubaan/shared';

import {
  findActiveUserByEmail,
  fullCatalogRiskIds,
  principalLabel,
  type AuthorityService,
  type GroundsShift,
  type MissionGrounds,
} from '../authority';
import { ConnectError, ownerActRefusal, type Actor, type ConnectionService } from '../connections';
import type { Logger } from '../logging';
import { enumerateCatalog } from '../missions/catalog-view';
import type { CatalogRisk } from '../missions/model';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import { InvariantError } from '../store/errors';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  GroupRecord,
  Principal,
  ShareRecord,
  UserRecord,
} from '../store/types';
import { ShareError, type ShareErrorCode } from './errors';
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
  /** Why `share` would refuse this connection whatever is asked; `null` when it can be shared. */
  readonly unshareable: UnshareableReason | null;
}

/** The two refusals of `share` that depend on the connection alone. */
export type UnshareableReason = Extract<
  ShareErrorCode,
  'connection-revoked' | 'connection-unowned'
>;

/**
 * Why nobody shares this connection (spec §2.3), or `null`. The connection's own rule
 * (`ownerActRefusal`) under the share codes: `share` refuses on it and the Share
 * dialog reads it from `ShareContext.unshareable`.
 */
export function unshareableReason(
  connection: Pick<ConnectionRecord, 'status'>,
): UnshareableReason | null {
  return ownerActRefusal(connection);
}

export interface ShareOutcome {
  readonly share: ShareRecord;
  readonly targetLabel: string;
  /** The share this one replaced, when the target already held one. */
  readonly replaced: ShareRecord | null;
  /** Missions that lost their grounds because the restriction shrank. */
  readonly orphaned: number;
  /**
   * Missions this share makes serve again: orphaned ones it grounds, and ones whose part
   * on this connection it brings back (their other connections kept serving meanwhile).
   */
  readonly restored: number;
}

/** One orphaned mission a share would ground again. */
export interface RestoredMission {
  readonly id: string;
  readonly name: string;
  /** Who issued it: the person whose agents would be served again. */
  readonly creatorLabel: string;
}

/** What a share would do, before it is made. */
export interface ShareForecast {
  readonly targetLabel: string;
  /** The restriction as it would be stored: catalog order, each id once. */
  readonly restriction: readonly RiskId[];
  /** Orphaned missions the share would ground again, oldest first. */
  readonly restores: readonly RestoredMission[];
}

export interface RevokeOutcome {
  readonly share: ShareRecord;
  readonly targetLabel: string;
  /** Missions that had nothing else to serve with: every call is refused. */
  readonly orphaned: number;
  /** Missions that lost this connection and keep serving through their others. */
  readonly partsLost: number;
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
  /** The service's mark, path and colour (`serviceIconOf`); `null` when the plugin declares no icon or is gone. */
  readonly providerIcon: ServiceIcon | null;
  readonly ownerLabel: string;
  /** How it reaches the user: `you`, or the group it was made to. */
  readonly via: string;
  /** The exact restriction, catalog order. */
  readonly risks: readonly ReceivedRisk[];
}

/**
 * Who holds a connection, or a part of it, said in names: what the page of the
 * connection prints under "Who has access". Owner only, like every read here.
 */
export interface HolderView {
  /** `unknown`: the user or the group no longer exists. */
  readonly kind: 'user' | 'group' | 'unknown';
  readonly id: string;
  /** A person's display name, else their email; a group's name. */
  readonly name: string;
  /** A person's email; `null` for a group. */
  readonly email: string | null;
  /** The reader is this person, or belongs to this group now. */
  readonly you: boolean;
  /** The people behind it now: the person, or the current members of the group. */
  readonly people: readonly HolderPerson[];
  /** A person who was deactivated and can no longer sign in; `false` for a group. */
  readonly inactive: boolean;
  /** A person's last sign-in; `null` for a group, and for someone who never signed in. */
  readonly lastLoginAt: string | null;
}

export interface HolderPerson {
  readonly id: string;
  readonly name: string;
  readonly you: boolean;
}

/** One active share with who holds it and who gave it. */
export interface HeldShare extends ShareView {
  readonly holder: HolderView;
  /** The owner who made the share, as a name; "unknown user" when their row is gone. */
  readonly givenBy: string;
}

export interface ConnectionHolders {
  readonly owner: HolderView;
  /** The active shares, oldest first. */
  readonly shares: readonly HeldShare[];
}

export interface ShareServiceDeps {
  readonly store: Pick<Store, 'shares' | 'connections' | 'users' | 'groups'>;
  readonly registry: PluginRegistry;
  readonly connections: Pick<ConnectionService, 'get'>;
  /** The one definition of "owns the connection now" (`basis: 'owner'`). */
  readonly authority: Pick<AuthorityService, 'authorityOf'>;
  readonly grounds: Pick<MissionGrounds, 'watchConnection' | 'forecastShare'>;
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
      providerLabel: detail.provider_label,
      risks: registered ? enumerateCatalog(registered.plugin.catalog) : [],
      groups: await this.deps.store.groups.list(),
      labelling: labellingOf(detail.resources, typeof registered?.plugin.envOf === 'function'),
      shares: await Promise.all(shares.map((share) => this.view(share))),
      unshareable: unshareableReason(connection),
    };
  }

  /**
   * What `share` would do with the same input, without doing it: the same refusals,
   * then the orphaned missions the share would bring back (spec §2.3: they serve calls
   * again with the token their agent holds, so the owner reads their names first).
   */
  async forecast(actor: Actor, connectionId: string, input: ShareInput): Promise<ShareForecast> {
    const { connection } = await this.owned(actor, connectionId);
    const unshareable = unshareableReason(connection);
    if (unshareable) throw new ShareError(unshareable);
    const restriction = this.restrictionOf(connection, input.riskIds);
    const target = await this.targetOf(connection, input.target);
    const restored = await this.deps.grounds.forecastShare({
      connectionId: connection.id,
      target,
      restriction,
    });
    const restores: RestoredMission[] = [];
    for (const mission of restored) {
      restores.push({
        id: mission.id,
        name: mission.name,
        creatorLabel: await principalLabel(this.deps.store, {
          kind: 'user',
          id: mission.creatorUserId,
        }),
      });
    }
    return {
      targetLabel: await principalLabel(this.deps.store, target),
      restriction,
      restores,
    };
  }

  /**
   * Shares the connection to a target, or replaces the restriction the target
   * already holds. Refused on a connection that is revoked or has no owner
   * (spec §2.3: "nobody can share … until the operator reassigns an owner").
   */
  async share(actor: Actor, connectionId: string, input: ShareInput): Promise<ShareOutcome> {
    const { connection } = await this.owned(actor, connectionId);
    const unshareable = unshareableReason(connection);
    if (unshareable) throw new ShareError(unshareable);
    const restriction = this.restrictionOf(connection, input.riskIds);
    const target = await this.targetOf(connection, input.target);

    const watch = await this.deps.grounds.watchConnection(connection.id);
    const { created, replaced } = await this.deps.store.shares.replaceForTarget({
      connectionId: connection.id,
      target,
      restriction,
      createdByUserId: actor.user.id,
    });
    // The share is stored: what it did to the missions is settled whether or not its
    // own entries could be written (the failure, if any, still reaches the caller).
    // A replacement may have narrowed the restriction under missions already issued;
    // a share made again may ground missions that an earlier revocation orphaned.
    let settled: GroundsShift;
    try {
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
    } finally {
      settled = await watch.settle(actor.user.id);
    }
    const { orphaned } = settled;
    const restored = [...settled.restored, ...settled.partsRestored];
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
   * Terminal for the share (spec §2.3). A mission it grounded loses its part on this
   * connection and serves through its others; one with nothing else reads `orphaned`.
   * Both serve again on this connection when a new share covers them.
   */
  async revoke(actor: Actor, shareId: string, connectionId: string): Promise<RevokeOutcome> {
    // The route names the connection in its URL: a share of another connection is not there.
    const share = await this.deps.store.shares.get({ connectionId, shareId });
    if (!share) throw new ShareError('not-found');
    await this.owned(actor, share.connectionId);
    const targetLabel = await principalLabel(this.deps.store, share.target);
    if (share.status === 'revoked') return { share, targetLabel, orphaned: 0, partsLost: 0 };

    const watch = await this.deps.grounds.watchConnection(share.connectionId);
    let revoked: ShareRecord;
    try {
      revoked = await this.deps.store.shares.revoke({ connectionId, shareId: share.id });
    } catch (err) {
      // Another revocation won between the read above and the conditional UPDATE: the
      // share is revoked, by the act that wrote its entry. Same answer as a repeat.
      const current =
        err instanceof InvariantError
          ? await this.deps.store.shares.get({ connectionId, shareId: share.id })
          : null;
      if (current?.status !== 'revoked') throw err;
      return { share: current, targetLabel, orphaned: 0, partsLost: 0 };
    }
    // The revocation is stored: the missions it orphaned are settled whether or not
    // its own entry could be written (the failure, if any, still reaches the caller).
    let settled: GroundsShift;
    try {
      await this.auditRevoked(actor, share, null);
    } finally {
      settled = await watch.settle(actor.user.id);
    }
    const { orphaned, partsLost } = settled;
    this.deps.logger.info('share revoked', {
      connection_id: share.connectionId,
      share_id: share.id,
      missions_orphaned: orphaned.length,
      missions_part_lost: partsLost.length,
    });
    return {
      share: revoked,
      targetLabel,
      orphaned: orphaned.length,
      partsLost: partsLost.length,
    };
  }

  /**
   * Who holds the connection: its owner and every active share, each with the people
   * behind it. Owner only. Read-only: nothing here decides — `authorityOf` does.
   */
  async holders(actor: Actor, connectionId: string): Promise<ConnectionHolders> {
    const { connection } = await this.owned(actor, connectionId);
    const shares = (await this.deps.store.shares.listForConnection(connection.id)).filter(
      (share) => share.status === 'active',
    );
    const held: HeldShare[] = [];
    for (const share of shares) {
      const giver = await this.deps.store.users.getById(share.createdByUserId);
      held.push({
        ...(await this.view(share)),
        holder: await this.holderOf(actor, share.target),
        givenBy: giver ? nameOf(giver) : 'unknown user',
      });
    }
    return {
      owner: await this.holderOf(actor, connection.owner),
      shares: held.sort((a, b) =>
        a.share.createdAt < b.share.createdAt ? -1 : a.share.createdAt > b.share.createdAt ? 1 : 0,
      ),
    };
  }

  private async holderOf(actor: Actor, principal: Principal): Promise<HolderView> {
    if (principal.kind === 'user') {
      const user = await this.deps.store.users.getById(principal.id);
      const you = principal.id === actor.user.id;
      if (!user) {
        return {
          kind: 'unknown',
          id: principal.id,
          name: 'unknown user',
          email: null,
          you,
          people: [],
          inactive: true,
          lastLoginAt: null,
        };
      }
      return {
        kind: 'user',
        id: user.id,
        name: nameOf(user),
        email: user.email,
        you,
        people: [{ id: user.id, name: nameOf(user), you }],
        inactive: user.status !== 'active',
        lastLoginAt: user.lastLoginAt,
      };
    }
    const group = await this.deps.store.groups.getById(principal.id);
    if (!group) {
      return {
        kind: 'unknown',
        id: principal.id,
        name: 'unknown group',
        email: null,
        you: false,
        people: [],
        inactive: false,
        lastLoginAt: null,
      };
    }
    const members = await this.deps.store.groups.listMembers(group.id);
    const people = members.map((member) => ({
      id: member.id,
      name: nameOf(member),
      you: member.id === actor.user.id,
    }));
    return {
      kind: 'group',
      id: group.id,
      name: group.name,
      email: null,
      you: people.some((person) => person.you),
      people,
      inactive: false,
      lastLoginAt: null,
    };
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
        providerIcon: registered ? serviceIconOf(registered.plugin) : null,
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
    // The authority's own enumeration: what a share may carry and what an authority
    // may return are one list (`authorityOf` filters a share by the same function).
    const catalog = fullCatalogRiskIds(registered.plugin.catalog);
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
    // Neither would a share to a current member of the owner group — except later: it
    // would keep the member's authority alive after they leave the group. Asked to the
    // authority itself, so "owner" has one meaning here and at every check.
    if (
      target.kind === 'user' &&
      (await this.deps.authority.authorityOf({ id: target.id }, connection)).basis === 'owner'
    ) {
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

/** What a page prints for a person: the name the identity provider gave, else the email. */
function nameOf(user: Pick<UserRecord, 'displayName' | 'email'>): string {
  return user.displayName?.trim() || user.email;
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
