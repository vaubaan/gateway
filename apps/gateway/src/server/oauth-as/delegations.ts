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
  MissionRecord,
  OAuthClientRecord,
  UserRecord,
} from '../store/types';
import type { ClientRegistry, ClientStatus } from './clients';

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
  /** The missions issued through this delegation, in the user's name (empty until P2.4). */
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
    for (const delegation of delegations) {
      const client = await repo.getClient(delegation.clientId);
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
    const { repo, audit, clock, logger } = this.deps;
    const delegation = await repo.getById(delegationId);
    if (!delegation || delegation.userId !== user.id) return { outcome: 'not-found' };
    const revoked = await repo.revokeIfActive(delegation.id, 'user');
    if (!revoked) return { outcome: 'already-revoked', delegation };
    const client = await repo.getClient(delegation.clientId);
    await audit.write({
      kind: 'admin',
      ts: toIso(clock.now()),
      user_id: user.id,
      act: 'delegation-revoked',
      object: { type: 'delegation', id: delegation.id },
      before: { status: 'active' },
      after: {
        status: 'revoked',
        reason: 'user',
        client_id: client?.clientId ?? null,
        client_name: client?.name ?? null,
      },
      delegated_client_id: null,
    });
    logger.info('delegation revoked', {
      delegation_id: delegation.id,
      user_id: user.id,
      client_id: client?.clientId ?? null,
      reason: 'user',
    });
    return { outcome: 'revoked', delegation: revoked };
  }
}
