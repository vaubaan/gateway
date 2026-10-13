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
   * client signing out, a detected replay) or the operator (`auditActorId`: they
   * disabled the client, or deactivated the user).
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
  /** Read only when a replay ends the delegation: the missions it issued are named. */
  readonly missions: Pick<MissionsRepo, 'listForCreator'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * True when the instance itself ended the delegation because a single-use
 * credential came back: two parties held it, and the instance cannot tell which
 * one issued what.
 */
export function endedByReplay(reason: DelegationRevokeReason | null): boolean {
  return reason === 'refresh-token-replay' || reason === 'authorization-code-replay';
}

/**
 * The missions a delegation issued that still serve, or may serve again: not
 * revoked, not expired. After a replay these are the ones whoever held the
 * stolen token may have issued, and whose mission token they would still
 * hold. `orphaned` is kept in: the authority may come back.
 *
 * They are **named, never revoked** (ADR
 * management-door-rotation-scope-and-replay-trace): most of the time the
 * honest client issued them and its agents are at work; ending them is the
 * creator's decision, made on the Delegations page with the list in front of
 * them.
 */
export function missionsToReview(
  delegation: Pick<DelegationRecord, 'id'>,
  missionsOfUser: readonly MissionRecord[],
  now: Date,
): MissionRecord[] {
  const nowIso = toIso(now);
  return missionsOfUser.filter(
    (mission) =>
      mission.delegationId === delegation.id &&
      mission.status !== 'revoked' &&
      mission.status !== 'expired' &&
      (mission.expiresAt === null || mission.expiresAt > nowIso),
  );
}

/**
 * The trace of a delegation that was just revoked — **the one place that writes
 * it**: a `delegation revoked` log line (`warn` for a replay, `info` otherwise)
 * and the `delegation-revoked` entry. The entry names the client, and the
 * delegating user when somebody else acted (`after.delegating_user_id`); the
 * delegating user finds it in their audit either way (the store's scope reads
 * the delegation's owner). After a replay it also names the missions to review
 * (`after.missions_to_review`: id and name of each mission the delegation
 * issued that still runs), passed as `review`; `null` when they could not be
 * read, and the key is then left out.
 */
export async function recordDelegationEnded(
  deps: Pick<EndDelegationDeps, 'audit' | 'clock' | 'logger'>,
  delegation: DelegationRecord,
  client: OAuthClientRecord | null,
  by: DelegationEnding,
  review: readonly MissionRecord[] | null = null,
): Promise<void> {
  const { audit, clock, logger } = deps;
  const replay = endedByReplay(by.reason);
  const log = replay ? logger.warn.bind(logger) : logger.info.bind(logger);
  log('delegation revoked', {
    delegation_id: delegation.id,
    user_id: delegation.userId,
    client_id: client?.clientId ?? null,
    reason: by.reason,
    ...(replay && review ? { missions_to_review: review.map((mission) => mission.id) } : {}),
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
      ...(replay && review
        ? {
            missions_to_review: review.map((mission) => ({
              mission_id: mission.id,
              name: mission.name,
            })),
          }
        : {}),
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
  const review = endedByReplay(by.reason) ? await missionsToReviewOf(deps, revoked) : null;
  await recordDelegationEnded(
    deps,
    revoked,
    await deps.repo.getClient(revoked.clientId),
    by,
    review,
  );
  return revoked;
}

/**
 * The missions to name after a replay, read once the delegation is revoked (nothing
 * more can be issued through it). A failure of this read must not cost the entry of
 * the revocation itself: it is logged, and the entry is written without the list —
 * absent, which is not the same as empty.
 */
async function missionsToReviewOf(
  deps: Pick<EndDelegationDeps, 'missions' | 'clock' | 'logger'>,
  revoked: DelegationRecord,
): Promise<MissionRecord[] | null> {
  try {
    return missionsToReview(
      revoked,
      await deps.missions.listForCreator(revoked.userId),
      deps.clock.now(),
    );
  } catch (err) {
    deps.logger.error('could not list the missions of a delegation revoked for a replay', {
      delegation_id: revoked.id,
      user_id: revoked.userId,
      err,
    });
    return null;
  }
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
  /** True when the instance revoked it on a replayed code or refresh token. */
  readonly replayed: boolean;
  /**
   * After a replay: the missions among `missions` that still run. Somebody else
   * held a token of this delegation and may have issued some of them. Empty for
   * any other delegation.
   */
  readonly toReview: readonly MissionRecord[];
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
    const instant = clock.now();
    const now = toIso(instant);
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
        replayed: endedByReplay(delegation.revokeReason),
        toReview: endedByReplay(delegation.revokeReason)
          ? missionsToReview(delegation, issued, instant)
          : [],
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

  /**
   * Ends every active delegation of one user, each with its tokens and its own
   * entry (`endDelegation`). For an act that removes the user's standing as a
   * whole — an operator deactivating them — never for a user's own choice among
   * their delegations. Returns the delegations this call ended.
   */
  async revokeAllOf(userId: string, by: DelegationEnding): Promise<DelegationRecord[]> {
    const ended: DelegationRecord[] = [];
    for (const delegation of await this.deps.repo.listForUser(userId)) {
      if (delegation.status !== 'active') continue;
      const revoked = await endDelegation(this.deps, delegation.id, by);
      if (revoked) ended.push(revoked);
    }
    return ended;
  }
}
