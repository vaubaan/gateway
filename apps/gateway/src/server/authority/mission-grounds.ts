/**
 * Mission grounds — is the authority a mission was issued under there, now?
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
 * `orphaned` is that verdict and nothing else: it is **derived on every
 * read, never stored**. The store keeps `active` for an orphaned mission, and
 * a migration trigger refuses the value. When the authority comes back (the
 * share is made again, the creator is back in the group at the next sign-in,
 * the operator reassigns the connection), the same mission serves calls
 * again, with the same token, the same session and the same counters. A
 * revoked connection never comes back, so its missions stay orphaned.
 *
 * Three ways in:
 *
 *   check(mission)       the verdict, from the store, right now
 *   inspect / derive     the mission as every reader must see it: `orphaned`
 *                        in place of `active` when the verdict says so. The
 *                        execution door asks on every request; the mission
 *                        and request services ask on every load. Nothing is
 *                        written, and no administrative entry either: no
 *                        human is behind a read.
 *   watch*(…)            the services, around a human act that may remove or
 *                        return an authority (a share made, replaced or
 *                        revoked, a connection revoked, transferred or
 *                        reassigned, a membership added or removed, a sign-in
 *                        that changed the user's groups): the verdicts are
 *                        taken before the act and again by `settle(actorId)`
 *                        after it, and each mission whose verdict changed
 *                        gets one entry naming that human: `mission-orphaned`
 *                        or `mission-restored`. The entry is written through
 *                        `AuditRepo.appendUnlessLatest`: a change another act
 *                        already recorded while this one was under way is
 *                        not recorded a second time.
 */
import type { RiskId } from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import type { Logger } from '../logging';
import type { AuditRepo } from '../store/repositories/audit';
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

/** Why a mission is orphaned right now. */
export interface OrphanReason {
  readonly cause: OrphanCause;
  /** The first connection the cause was met on; `null` when the creator is gone. */
  readonly connectionId: string | null;
  /** The accepted risks the creator no longer covers (empty unless `authority-lost`). */
  readonly uncovered: readonly RiskId[];
}

export type GroundsVerdict =
  | { readonly grounded: true }
  | ({ readonly grounded: false } & OrphanReason);

/** A mission as a reader sees it, with the reason when it reads `orphaned`. */
export interface InspectedMission {
  /** `status` is `orphaned` when the stored one is `active` and the grounds are gone. */
  readonly mission: MissionRecord;
  readonly orphan: OrphanReason | null;
}

/** What a human act did to the missions that were watched around it. */
export interface GroundsShift {
  /** Grounded before the act, orphaned after it. */
  readonly orphaned: readonly MissionRecord[];
  /** Orphaned before the act, grounded after it. */
  readonly restored: readonly MissionRecord[];
}

/** The verdicts taken before a human act; `settle` compares them with the ones after it. */
export interface GroundsWatch {
  /** `actorId` is the human behind the act: every entry written names them. */
  settle(actorId: string): Promise<GroundsShift>;
}

export interface MissionGroundsDeps {
  readonly authority: AuthorityRecheck;
  readonly missions: Pick<MissionsRepo, 'listForConnection' | 'listForCreator'>;
  readonly connections: Pick<ConnectionsRepo, 'getById'>;
  /** The trail itself, not the `AuditWriter`: the write is conditional on its latest entry. */
  readonly audit: Pick<AuditRepo, 'appendUnlessLatest'>;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The two acts that alternate on a mission; the idempotent write compares within them. */
const GROUNDS_ACTS = ['mission-orphaned', 'mission-restored'] as const;
type GroundsAct = (typeof GROUNDS_ACTS)[number];

const GROUNDED: GroundsVerdict = { grounded: true };
const NO_SHIFT: GroundsShift = { orphaned: [], restored: [] };

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
   * The mission as a reader must see it, with the reason when it is orphaned.
   * Only a mission the store holds as `active` is checked: `revoked` and
   * `expired` are stored facts no authority changes, returned without a read.
   */
  async inspect(mission: MissionRecord): Promise<InspectedMission> {
    if (mission.status !== 'active') return { mission, orphan: null };
    const verdict = await this.check(mission);
    if (verdict.grounded) return { mission, orphan: null };
    const { cause, connectionId, uncovered } = verdict;
    return {
      mission: { ...mission, status: 'orphaned' },
      orphan: { cause, connectionId, uncovered },
    };
  }

  /** `inspect` without the reason. */
  async derive(mission: MissionRecord): Promise<MissionRecord> {
    return (await this.inspect(mission)).mission;
  }

  /** Before an act on one connection (its shares, its owner, its revocation). */
  async watchConnection(connectionId: string): Promise<GroundsWatch> {
    return this.watch(() => this.deps.missions.listForConnection(connectionId));
  }

  /** Before an act on one user's memberships: the missions that user created. */
  async watchCreator(userId: string): Promise<GroundsWatch> {
    return this.watch(() => this.deps.missions.listForCreator(userId));
  }

  // single-process only: watch → act → settle is not one transaction. Two acts under
  // way at once that both see one change record it once (`AuditRepo.appendUnlessLatest`
  // holds the second entry back). The mirror case remains: when another act undoes the
  // change before this one settles, this watch sees the same verdict before and after
  // and writes nothing, so the trail can hold a `mission-restored` with no
  // `mission-orphaned` before it (or the reverse). Not reachable while every store call
  // is synchronous in one process; with a second process or an asynchronous driver,
  // replace with a store transaction spanning the watch, the act and the settlement
  // (a `Store.transaction(fn)` unit of work the services would run their act in).
  private async watch(list: () => Promise<MissionRecord[]>): Promise<GroundsWatch> {
    const since = toIso(this.deps.clock.now());
    const before = await this.verdictsOf(await list());
    return {
      settle: async (actorId) => {
        if (before.size === 0) return NO_SHIFT;
        const orphaned: MissionRecord[] = [];
        const restored: MissionRecord[] = [];
        // Listed again: a mission revoked during the act is no longer `active`,
        // and one issued during it was not watched.
        for (const mission of await list()) {
          const was = before.get(mission.id);
          if (!was || mission.status !== 'active') continue;
          const now = await this.check(mission);
          if (was.grounded === now.grounded) continue;
          const act: GroundsAct = now.grounded ? 'mission-restored' : 'mission-orphaned';
          // Counted only when this act's entry was written: a change another act
          // recorded since the watch was taken is theirs, in the trail and in the notice.
          if (!(await this.record(mission, act, actorId, was, now, since))) continue;
          if (now.grounded) restored.push(mission);
          else orphaned.push({ ...mission, status: 'orphaned' });
        }
        return { orphaned, restored };
      },
    };
  }

  /** The verdict of each mission the store holds as `active`, by mission id. */
  private async verdictsOf(
    missions: readonly MissionRecord[],
  ): Promise<Map<string, GroundsVerdict>> {
    const verdicts = new Map<string, GroundsVerdict>();
    for (const mission of missions) {
      if (mission.status !== 'active') continue;
      verdicts.set(mission.id, await this.check(mission));
    }
    return verdicts;
  }

  /**
   * Writes the entry unless the mission's latest grounds entry is the same act and
   * was written since `watchedSince`: then another act recorded this very change.
   * An equal entry from before the watch is an earlier change (the one in between
   * went unrecorded, or was purged), and does not hold this one back. Returns
   * whether the entry was written.
   */
  private async record(
    mission: MissionRecord,
    act: GroundsAct,
    actorId: string,
    before: GroundsVerdict,
    after: GroundsVerdict,
    watchedSince: string,
  ): Promise<boolean> {
    const written = await this.deps.audit.appendUnlessLatest(
      {
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actorId,
        act,
        object: { type: 'mission', id: mission.id },
        before: stateOf(before),
        after: stateOf(after),
        delegated_client_id: null,
      },
      { among: GROUNDS_ACTS, since: watchedSince },
    );
    if (written === null) return false;
    this.deps.logger.warn(act === 'mission-orphaned' ? 'mission orphaned' : 'mission restored', {
      mission_id: mission.id,
      actor_id: actorId,
      ...reasonFields(before.grounded ? after : before),
    });
    return true;
  }
}

function ungrounded(
  cause: OrphanCause,
  connectionId: string | null,
  uncovered: readonly RiskId[] = [],
): GroundsVerdict {
  return { grounded: false, cause, connectionId, uncovered };
}

function reasonFields(verdict: GroundsVerdict): Record<string, unknown> {
  if (verdict.grounded) return {};
  return {
    cause: verdict.cause,
    connection_id: verdict.connectionId,
    uncovered: verdict.uncovered,
  };
}

/** One side of an audit entry: the derived state, with the reason when orphaned. */
function stateOf(verdict: GroundsVerdict): Record<string, unknown> {
  return { status: verdict.grounded ? 'active' : 'orphaned', ...reasonFields(verdict) };
}
