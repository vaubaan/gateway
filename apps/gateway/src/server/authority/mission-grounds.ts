/**
 * Mission grounds — is the authority a mission was issued under still there?
 * (spec §2.3 "orphaned", §7.8).
 *
 * A mission is grounded while its creator, *now*, still covers on every
 * connection the mission carries the accepted risks of that connection:
 *
 *   creator-removed      the creator is unknown or was removed from the IdP
 *   connection-missing   a connection of the mission no longer exists
 *   connection-revoked   a connection of the mission was revoked (terminal)
 *   authority-lost       the creator no longer covers some accepted risk: the
 *                        share that grounded it was revoked or narrowed, or
 *                        they left the group that owned or received it
 *
 * An ungrounded `active` mission becomes `orphaned`: a stored, final status
 * (`MissionsRepo.markOrphaned`, conditional on `active`). Authority that
 * comes back later does not revive it; the creator issues a new mission,
 * which is checked against what they hold then. The derivation itself is
 * never stored: `check` reads the creator's status, their memberships and the
 * active shares on every call.
 *
 * Two ways in:
 *
 *   settle(mission)      the execution door, on every request (no human
 *                        behind it: the transition is logged, and the call
 *                        that met it is audited as `mission-inactive`)
 *   sweep*(…, actorId)   the services, right after the act that may have
 *                        removed an authority (a share revoked or replaced, a
 *                        connection revoked, transferred or reassigned, a
 *                        membership removed, a sign-in that changed the
 *                        user's groups): one `mission-orphaned` entry per
 *                        mission, naming the human behind that act
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import type { RiskId } from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import type { Logger } from '../logging';
import type { ConnectionsRepo } from '../store/repositories/connections';
import type { MissionsRepo } from '../store/repositories/missions';
import { toIso, type Clock } from '../store/clock';
import type { MissionRecord } from '../store/types';
import type { AuthorityQuestion, AuthorityRecheck } from './authority-service';

export const ORPHAN_CAUSES = [
  'creator-removed',
  'connection-missing',
  'connection-revoked',
  'authority-lost',
] as const;
export type OrphanCause = (typeof ORPHAN_CAUSES)[number];

export type GroundsVerdict =
  | { readonly grounded: true }
  | {
      readonly grounded: false;
      readonly cause: OrphanCause;
      /** The first connection the cause was met on; `null` when the creator is gone. */
      readonly connectionId: string | null;
      /** The accepted risks the creator no longer covers (empty unless `authority-lost`). */
      readonly uncovered: readonly RiskId[];
    };

export interface MissionGroundsDeps {
  readonly authority: AuthorityRecheck;
  readonly missions: Pick<
    MissionsRepo,
    'getById' | 'markOrphaned' | 'listForConnection' | 'listForCreator'
  >;
  readonly connections: Pick<ConnectionsRepo, 'getById'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

const GROUNDED: GroundsVerdict = { grounded: true };

/**
 * The accepted risks of a mission that belong to one connection (spec §3.1
 * "A multi-connection mission": the policy is partitioned per connection, by
 * the provider each id names).
 */
export function partitionOf(mission: Pick<MissionRecord, 'policy'>, provider: string): RiskId[] {
  return mission.policy
    .map((entry) => entry.riskId)
    .filter((id) => parseRiskId(id)?.provider === provider);
}

export class MissionGrounds {
  constructor(private readonly deps: MissionGroundsDeps) {}

  /** The verdict right now. Reads only; nothing is remembered between two calls. */
  async check(mission: MissionRecord): Promise<GroundsVerdict> {
    const questions: AuthorityQuestion[] = [];
    for (const selection of mission.connections) {
      const connection = await this.deps.connections.getById(selection.connectionId);
      if (!connection) {
        return ungrounded('connection-missing', selection.connectionId);
      }
      if (connection.status === 'revoked') return ungrounded('connection-revoked', connection.id);
      questions.push({ connection, riskIds: partitionOf(mission, connection.provider) });
    }
    const { subjectRemoved, gaps } = await this.deps.authority.gapsOf(
      { id: mission.creatorUserId },
      questions,
    );
    if (subjectRemoved) return ungrounded('creator-removed', null);
    const [first] = gaps;
    if (!first) return GROUNDED;
    return ungrounded(
      'authority-lost',
      first.connectionId,
      gaps.flatMap((gap) => gap.uncovered),
    );
  }

  /**
   * The mission as the door must see it: an `active` mission whose grounds
   * vanished is turned `orphaned` first. A mission in any other status is
   * returned untouched, without a read.
   */
  async settle(mission: MissionRecord): Promise<MissionRecord> {
    if (mission.status !== 'active') return mission;
    const verdict = await this.check(mission);
    if (verdict.grounded) return mission;
    return (await this.orphan(mission, verdict, null)) ?? mission;
  }

  /** Re-checks the active missions that carry the connection. Returns the ones orphaned. */
  async sweepConnection(connectionId: string, actorId: string): Promise<MissionRecord[]> {
    return this.sweep(await this.deps.missions.listForConnection(connectionId), actorId);
  }

  /** Re-checks the active missions the user created. Returns the ones orphaned. */
  async sweepCreator(userId: string, actorId: string): Promise<MissionRecord[]> {
    return this.sweep(await this.deps.missions.listForCreator(userId), actorId);
  }

  private async sweep(
    missions: readonly MissionRecord[],
    actorId: string,
  ): Promise<MissionRecord[]> {
    const orphaned: MissionRecord[] = [];
    for (const mission of missions) {
      if (mission.status !== 'active') continue;
      const verdict = await this.check(mission);
      if (verdict.grounded) continue;
      const after = await this.orphan(mission, verdict, actorId);
      if (after) orphaned.push(after);
    }
    return orphaned;
  }

  /** `active` → `orphaned`; `null` when another path closed the mission first. */
  private async orphan(
    mission: MissionRecord,
    verdict: Extract<GroundsVerdict, { grounded: false }>,
    actorId: string | null,
  ): Promise<MissionRecord | null> {
    if (!(await this.deps.missions.markOrphaned(mission.id))) {
      return this.deps.missions.getById(mission.id);
    }
    this.deps.logger.warn('mission orphaned', {
      mission_id: mission.id,
      cause: verdict.cause,
      connection_id: verdict.connectionId,
      uncovered: verdict.uncovered,
      detected_by: actorId === null ? 'execution-door' : 'sweep',
    });
    if (actorId !== null) {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actorId,
        act: 'mission-orphaned',
        object: { type: 'mission', id: mission.id },
        before: { status: mission.status },
        after: {
          status: 'orphaned',
          cause: verdict.cause,
          connection_id: verdict.connectionId,
          uncovered: verdict.uncovered,
        },
        delegated_client_id: null,
      });
    }
    return this.deps.missions.getById(mission.id);
  }
}

function ungrounded(
  cause: OrphanCause,
  connectionId: string | null,
  uncovered: readonly RiskId[] = [],
): GroundsVerdict {
  return { grounded: false, cause, connectionId, uncovered };
}
