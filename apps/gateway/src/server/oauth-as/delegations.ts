/**
 * A user's delegations (spec §4.1 bis "a user sees their delegations in the
 * interface, with the client holding each one and the missions it issued, and
 * may revoke them in one click"; §4.2 "Delegations").
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type { DelegationsRepo } from '../store/repositories/delegations';
import type { MissionsRepo } from '../store/repositories/missions';
import type {
  DelegationRecord,
  DelegationRevokeReason,
  MissionRecord,
  OAuthClientRecord,
  UserRecord,
} from '../store/types';
import type { ClientRegistry, ClientStatus } from './clients';

/** Who ended a delegation, and why. */
export interface DelegationEnding {
  readonly reason: DelegationRevokeReason;
  /**
   * In whose name the entry is written: the delegating user (their own act, their
   * client signing out, a detected replay) or the operator (`auditActorId`).
   */
  readonly actorId: string;
  /**
   * True when the act arrived through the client, at a protocol endpoint (sign-out,
   * replay): the entry then names it as `delegated_client_id`. False for an act of a
   * human in the interface.
   */
  readonly viaClient: boolean;
}

export interface EndDelegationDeps {
  readonly repo: Pick<DelegationsRepo, 'revokeIfActive' | 'getClient'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * The trace of a delegation that was just revoked — **the one place that writes
 * it**: a `delegation revoked` log line (`warn` for a replay, `info` otherwise)
 * and the `delegation-revoked` entry. The entry names the client, and the
 * delegating user when somebody else acted (`after.delegating_user_id`); the
 * delegating user finds it in their audit either way (the store's scope reads
 * the delegation's owner).
 */
export async function recordDelegationEnded(
  deps: Pick<EndDelegationDeps, 'audit' | 'clock' | 'logger'>,
  delegation: DelegationRecord,
  client: OAuthClientRecord | null,
  by: DelegationEnding,
): Promise<void> {
  const { audit, clock, logger } = deps;
  const replay = by.reason === 'refresh-token-replay' || by.reason === 'authorization-code-replay';
  const log = replay ? logger.warn.bind(logger) : logger.info.bind(logger);
  log('delegation revoked', {
    delegation_id: delegation.id,
    user_id: delegation.userId,
    client_id: client?.clientId ?? null,
    reason: by.reason,
  });
  await audit.write({
    kind: 'admin',
    ts: toIso(clock.now()),
    user_id: by.actorId,
    act: 'delegation-revoked',
    object: { type: 'delegation', id: delegation.id },
    before: { status: 'active' },
    after: {
      status: 'revoked',
      reason: by.reason,
      ...(by.actorId === delegation.userId ? {} : { delegating_user_id: delegation.userId }),
      client_id: client?.clientId ?? null,
      client_name: client?.name ?? null,
    },
    delegated_client_id: by.viaClient ? (client?.clientId ?? null) : null,
  });
}

/**
 * Revokes a delegation with every token under it and leaves its trace, once:
 * the store's `revokeIfActive` answers only to the call that actually revoked,
 * so two requests that notice the same thing write one entry. `null` when the
 * delegation was already revoked (or does not exist): nothing was written.
 */
export async function endDelegation(
  deps: EndDelegationDeps,
  delegationId: string,
  by: DelegationEnding,
): Promise<DelegationRecord | null> {
  const revoked = await deps.repo.revokeIfActive(delegationId, by.reason);
  if (!revoked) return null;
  await recordDelegationEnded(deps, revoked, await deps.repo.getClient(revoked.clientId), by);
  return revoked;
}

/**
 * `active`: a token of the delegation is live. `idle`: the consent stands but
 * no token is left (never redeemed, or unused past the refresh lifetime): the
 * client must ask again. `revoked`: ended, with the reason.
 */
export type DelegationState = 'active' | 'idle' | 'revoked';

export interface DelegationView {
  readonly delegation: DelegationRecord;
  readonly state: DelegationState;
  readonly client: OAuthClientRecord;
  readonly clientStatus: ClientStatus;
  /** When the client last obtained a token under this delegation. */
  readonly lastTokenAt: string | null;
  /** Until when it can keep acting without the user (the latest live token). */
  readonly liveUntil: string | null;
  /** The missions issued through this delegation, in the user's name. */
  readonly missions: readonly MissionRecord[];
}

export type RevokeDelegationResult =
  | { readonly outcome: 'revoked'; readonly delegation: DelegationRecord }
  | { readonly outcome: 'already-revoked'; readonly delegation: DelegationRecord }
  /** No such delegation of this user (another user's reads the same). */
  | { readonly outcome: 'not-found' };

export interface DelegationServiceDeps {
  readonly repo: DelegationsRepo;
  readonly missions: Pick<MissionsRepo, 'listForCreator'>;
  readonly clients: ClientRegistry;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  /** The user's delegations, most recent first, each with its client and its missions. */
  async listFor(user: UserRecord): Promise<DelegationView[]> {
    const { repo, missions, clients, clock } = this.deps;
    const delegations = await repo.listForUser(user.id);
    if (delegations.length === 0) return [];
    const activity = await repo.activityOf(delegations.map((d) => d.id));
    const issued = (await missions.listForCreator(user.id)).filter(
      (mission) => mission.delegationId !== null,
    );
    const now = toIso(clock.now());
    const views: DelegationView[] = [];
    // One read per client, however many delegations it holds.
    const clientsById = new Map<string, OAuthClientRecord | null>();
    for (const delegation of delegations) {
      if (!clientsById.has(delegation.clientId)) {
        clientsById.set(delegation.clientId, await repo.getClient(delegation.clientId));
      }
      const client = clientsById.get(delegation.clientId);
      if (!client) continue;
      const tokens = activity.get(delegation.id);
      const liveUntil = tokens?.liveUntil ?? null;
      views.push({
        delegation,
        state:
          delegation.status === 'revoked'
            ? 'revoked'
            : liveUntil !== null && liveUntil > now
              ? 'active'
              : 'idle',
        client,
        clientStatus: clients.statusOf(client),
        lastTokenAt: tokens?.lastTokenAt ?? null,
        liveUntil: delegation.status === 'revoked' ? null : liveUntil,
        missions: issued.filter((mission) => mission.delegationId === delegation.id),
      });
    }
    return views.reverse();
  }

  /**
   * The user ends one of their delegations: its refresh and access tokens stop
   * working at once. The missions it issued are theirs and stay.
   */
  async revoke(user: UserRecord, delegationId: string): Promise<RevokeDelegationResult> {
    const delegation = await this.deps.repo.getById(delegationId);
    if (!delegation || delegation.userId !== user.id) return { outcome: 'not-found' };
    const revoked = await endDelegation(this.deps, delegation.id, {
      reason: 'user',
      actorId: user.id,
      viaClient: false,
    });
    if (!revoked) return { outcome: 'already-revoked', delegation };
    return { outcome: 'revoked', delegation: revoked };
  }
}
