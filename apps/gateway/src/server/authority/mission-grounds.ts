/**
 * Mission grounds — is the authority a mission was issued under there, now?
 * (spec §2.3 "orphaned", §7.8).
 *
 * Each connection a mission carries is a PART of it, grounded on its own
 * (ADR orphaned-missions-and-ownerless-connections, amendment 2026-10-21).
 * A part is LOST when the authority of that one connection is gone:
 *
 *   connection-revoked   the connection was revoked (final)
 *   connection-missing   the connection no longer exists (final)
 *   access-withdrawn     the creator holds nothing on it any more: the share
 *                        that grounded it was revoked, or they left the group
 *                        that owned or received it (comes back with the access)
 *
 * The mission keeps serving through its other parts; a call that needs a lost
 * part is refused `connection-revoked`. The whole mission is ORPHANED when:
 *
 *   creator-removed      the creator is unknown or was removed from the IdP
 *   authority-lost       the creator still holds a connection but no longer
 *                        covers some of its accepted risks (a share narrowed),
 *                        or every part is lost and one of them may come back
 *   connection-revoked   every part is lost for good (revoked connections)
 *   connection-missing   idem, the first lost part being a missing connection
 *
 * `orphaned` is that verdict and nothing else: it is **derived on every
 * read, never stored**. The store keeps `active` for an orphaned mission, and
 * a migration trigger refuses the value. When the authority comes back (the
 * share is made again, the creator is back in the group at the next sign-in,
 * the operator reassigns the connection), the same mission serves calls
 * again, with the same token, the same session and the same counters; so does
 * a part whose access was withdrawn. A revoked connection never comes back:
 * its part stays lost, and a mission with nothing else stays orphaned.
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
 *   forecastShare(…)     before a share is made: the missions it would bring
 *                        back, so that the owner reads them before confirming.
 *                        Reads only.
 *   watch*(…)            the services, around a human act that may remove or
 *                        return an authority (a share made, replaced or
 *                        revoked, a connection revoked, transferred or
 *                        reassigned, a membership added or removed, a sign-in
 *                        that changed the user's groups): the verdicts are
 *                        taken before the act and again by `settle(actorId)`
 *                        after it, and each mission whose verdict changed
 *                        gets one entry naming that human: `mission-orphaned`
 *                        or `mission-restored` for the whole mission,
 *                        `mission-connection-lost` or
 *                        `mission-connection-restored` for a part of one that
 *                        keeps serving. The entry is written through
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
import type { AuthorityQuestion, AuthorityRecheck, SupposedShare } from './authority-service';

export const ORPHAN_CAUSES = [
  'creator-removed',
  'connection-missing',
  'connection-revoked',
  'authority-lost',
] as const;
export type OrphanCause = (typeof ORPHAN_CAUSES)[number];

/** Why one connection of a mission no longer serves it. */
export const PART_LOSS_CAUSES = [
  'connection-revoked',
  'connection-missing',
  'access-withdrawn',
] as const;
export type PartLossCause = (typeof PART_LOSS_CAUSES)[number];

/** A connection of a mission that serves it no more (its part of the mission is lost). */
export interface LostPart {
  readonly connectionId: string;
  readonly cause: PartLossCause;
  /** The accepted risks of that connection (empty when the connection is missing). */
  readonly uncovered: readonly RiskId[];
}

/** True when nothing brings the part back: the connection was revoked or is gone. */
export function isFinalLoss(cause: PartLossCause): boolean {
  return cause !== 'access-withdrawn';
}

/** Why a mission is orphaned right now. */
export interface OrphanReason {
  readonly cause: OrphanCause;
  /** The first connection the cause was met on; `null` when the creator is gone. */
  readonly connectionId: string | null;
  /** The accepted risks the creator no longer covers (empty unless `authority-lost`). */
  readonly uncovered: readonly RiskId[];
}

/** `lost`: the parts that serve no more, in the mission's order of connections. */
export type GroundsVerdict =
  | { readonly grounded: true; readonly lost: readonly LostPart[] }
  | ({ readonly grounded: false; readonly lost: readonly LostPart[] } & OrphanReason);

/** A mission as a reader sees it, with the reason when it reads `orphaned`. */
export interface InspectedMission {
  /** `status` is `orphaned` when the stored one is `active` and the grounds are gone. */
  readonly mission: MissionRecord;
  readonly orphan: OrphanReason | null;
  /** The connections whose part is lost; the mission may still serve through the others. */
  readonly lost: readonly LostPart[];
}

/** What a human act did to the missions that were watched around it. */
export interface GroundsShift {
  /** Grounded before the act, orphaned after it. */
  readonly orphaned: readonly MissionRecord[];
  /** Orphaned before the act, grounded after it. */
  readonly restored: readonly MissionRecord[];
  /** Grounded before and after, with a connection lost by the act: they serve with the others. */
  readonly partsLost: readonly MissionRecord[];
  /** Grounded before and after, with a lost connection that serves again since the act. */
  readonly partsRestored: readonly MissionRecord[];
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
/** The same for one part of a mission that keeps serving. */
const PART_ACTS = ['mission-connection-lost', 'mission-connection-restored'] as const;
type GroundsAct = (typeof GROUNDS_ACTS)[number] | (typeof PART_ACTS)[number];

const NO_SHIFT: GroundsShift = { orphaned: [], restored: [], partsLost: [], partsRestored: [] };

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

  /**
   * The verdict right now. Reads only; nothing is remembered between two calls.
   * `supposing` asks for the verdict as it would be once that share is made: only
   * `forecastShare` passes it, and no reader of a mission's state does.
   */
  async check(mission: MissionRecord, supposing?: SupposedShare): Promise<GroundsVerdict> {
    const lost = new Map<string, LostPart>();
    const questions: AuthorityQuestion[] = [];
    for (const selection of mission.connections) {
      const connection = await this.deps.connections.getById(selection.connectionId);
      if (!connection) {
        lost.set(selection.connectionId, {
          connectionId: selection.connectionId,
          cause: 'connection-missing',
          uncovered: [],
        });
        continue;
      }
      const riskIds = partitionOf(mission, connection.provider);
      if (connection.status === 'revoked') {
        lost.set(connection.id, {
          connectionId: connection.id,
          cause: 'connection-revoked',
          uncovered: riskIds,
        });
        continue;
      }
      questions.push({ connection, riskIds });
    }
    const inOrder = (): LostPart[] =>
      mission.connections.flatMap((c) => {
        const part = lost.get(c.connectionId);
        return part ? [part] : [];
      });
    // Nothing left to ask about: whatever the creator holds, no part serves.
    if (questions.length === 0) return lost.size > 0 ? wholeLoss(inOrder()) : grounded([]);

    const { subjectRemoved, gaps } = await this.deps.authority.gapsOf(
      { id: mission.creatorUserId },
      questions,
      supposing,
    );
    if (subjectRemoved) return ungrounded('creator-removed', null, [], inOrder());
    const narrowed: (typeof gaps)[number][] = [];
    for (const gap of gaps) {
      // `none`: the creator holds nothing on this connection any more. Its part is
      // lost like a revoked one, but it comes back with the access.
      if (gap.basis === 'none') {
        lost.set(gap.connectionId, {
          connectionId: gap.connectionId,
          cause: 'access-withdrawn',
          uncovered: gap.uncovered,
        });
      } else narrowed.push(gap);
    }
    const [first] = narrowed;
    if (first) {
      return ungrounded(
        'authority-lost',
        first.connectionId,
        narrowed.flatMap((gap) => gap.uncovered),
        inOrder(),
      );
    }
    // A part serves while its connection is not lost and carries an accepted risk.
    const serving = questions.some((q) => q.riskIds.length > 0 && !lost.has(q.connection.id));
    if (lost.size > 0 && !serving) return wholeLoss(inOrder());
    return grounded(inOrder());
  }

  /**
   * The mission as a reader must see it, with the reason when it is orphaned.
   * Only a mission the store holds as `active` is checked: `revoked` and
   * `expired` are stored facts no authority changes, returned without a read.
   */
  async inspect(mission: MissionRecord): Promise<InspectedMission> {
    if (mission.status !== 'active') return { mission, orphan: null, lost: [] };
    const verdict = await this.check(mission);
    if (verdict.grounded) return { mission, orphan: null, lost: verdict.lost };
    const { cause, connectionId, uncovered, lost } = verdict;
    return {
      mission: { ...mission, status: 'orphaned' },
      orphan: { cause, connectionId, uncovered },
      lost,
    };
  }

  /** `inspect` without the reason. */
  async derive(mission: MissionRecord): Promise<MissionRecord> {
    return (await this.inspect(mission)).mission;
  }

  /**
   * The missions of the connection that would serve calls again once `share` is made,
   * with the token their agent still holds: the orphaned ones it would ground, and the
   * ones whose part on this connection it would bring back. Nothing is written. What
   * `settle` records after the act is the truth of the act; this is what the owner is
   * shown before it.
   */
  async forecastShare(share: SupposedShare): Promise<MissionRecord[]> {
    const restored: MissionRecord[] = [];
    for (const mission of await this.deps.missions.listForConnection(share.connectionId)) {
      if (mission.status !== 'active') continue;
      const now = await this.check(mission);
      if (now.grounded && !isLostOn(now, share.connectionId)) continue;
      const then = await this.check(mission, share);
      if (!then.grounded) continue;
      if (!now.grounded || !isLostOn(then, share.connectionId)) restored.push(mission);
    }
    return restored;
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
        const partsLost: MissionRecord[] = [];
        const partsRestored: MissionRecord[] = [];
        // Listed again: a mission revoked during the act is no longer `active`,
        // and one issued during it was not watched.
        for (const mission of await list()) {
          const was = before.get(mission.id);
          if (!was || mission.status !== 'active') continue;
          const now = await this.check(mission);
          if (was.grounded !== now.grounded) {
            const act: GroundsAct = now.grounded ? 'mission-restored' : 'mission-orphaned';
            const entry = { before: stateOf(was), after: stateOf(now) };
            // Counted only when this act's entry was written: a change another act
            // recorded since the watch was taken is theirs, in the trail and in the notice.
            if (!(await this.record(mission, act, GROUNDS_ACTS, actorId, entry, since))) continue;
            if (now.grounded) restored.push(mission);
            else orphaned.push({ ...mission, status: 'orphaned' });
            continue;
          }
          // Orphaned before and after: nothing serves either way, the parts are not followed.
          if (!now.grounded) continue;
          const newlyLost = now.lost.filter((part) => !sameLoss(was.lost, part));
          const back = was.lost.filter((part) => !isLostOn(now, part.connectionId));
          if (newlyLost.length > 0) {
            const entry = {
              before: { status: 'active', lost: partsOf(was.lost) },
              after: { status: 'active', lost: partsOf(now.lost), newly_lost: partsOf(newlyLost) },
            };
            const act = 'mission-connection-lost';
            if (await this.record(mission, act, PART_ACTS, actorId, entry, since)) {
              partsLost.push(mission);
            }
          }
          if (back.length > 0) {
            const entry = {
              before: { status: 'active', lost: partsOf(was.lost) },
              after: { status: 'active', lost: partsOf(now.lost), restored: partsOf(back) },
            };
            const act = 'mission-connection-restored';
            if (await this.record(mission, act, PART_ACTS, actorId, entry, since)) {
              partsRestored.push(mission);
            }
          }
        }
        return { orphaned, restored, partsLost, partsRestored };
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
   * Writes the entry unless the mission's latest entry among `among` is the same act and
   * was written since `watchedSince`: then another act recorded this very change.
   * An equal entry from before the watch is an earlier change (the one in between
   * went unrecorded, or was purged), and does not hold this one back. Returns
   * whether the entry was written.
   */
  private async record(
    mission: MissionRecord,
    act: GroundsAct,
    among: readonly GroundsAct[],
    actorId: string,
    entry: { readonly before: Record<string, unknown>; readonly after: Record<string, unknown> },
    watchedSince: string,
  ): Promise<boolean> {
    const written = await this.deps.audit.appendUnlessLatest(
      {
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actorId,
        act,
        object: { type: 'mission', id: mission.id },
        before: entry.before,
        after: entry.after,
        delegated_client_id: null,
      },
      { among, since: watchedSince },
    );
    if (written === null) return false;
    this.deps.logger.warn(LOG_LINE[act], {
      mission_id: mission.id,
      actor_id: actorId,
      before: entry.before,
      after: entry.after,
    });
    return true;
  }
}

const LOG_LINE: Readonly<Record<GroundsAct, string>> = {
  'mission-orphaned': 'mission orphaned',
  'mission-restored': 'mission restored',
  'mission-connection-lost': 'mission lost a connection',
  'mission-connection-restored': 'mission connection serves again',
};

function grounded(lost: readonly LostPart[]): GroundsVerdict {
  return { grounded: true, lost };
}

/**
 * Every part is lost: orphaned. While one of them may come back (an access withdrawn),
 * the cause is `authority-lost` and names it; otherwise the first loss, which is final.
 */
function wholeLoss(lost: readonly LostPart[]): GroundsVerdict {
  const withdrawn = lost.filter((part) => !isFinalLoss(part.cause));
  const [first] = withdrawn;
  if (first) {
    return ungrounded(
      'authority-lost',
      first.connectionId,
      withdrawn.flatMap((part) => part.uncovered),
      lost,
    );
  }
  const [final] = lost;
  if (!final) return grounded([]);
  const cause: OrphanCause =
    final.cause === 'connection-missing' ? 'connection-missing' : 'connection-revoked';
  return ungrounded(cause, final.connectionId, [], lost);
}

function isLostOn(verdict: GroundsVerdict, connectionId: string): boolean {
  return verdict.lost.some((part) => part.connectionId === connectionId);
}

/** The same connection lost for the same cause: an access withdrawn, then revoked, is a new loss. */
function sameLoss(parts: readonly LostPart[], part: LostPart): boolean {
  return parts.some((p) => p.connectionId === part.connectionId && p.cause === part.cause);
}

function partsOf(parts: readonly LostPart[]): Record<string, unknown>[] {
  return parts.map((part) => ({ connection_id: part.connectionId, cause: part.cause }));
}

function ungrounded(
  cause: OrphanCause,
  connectionId: string | null,
  uncovered: readonly RiskId[],
  lost: readonly LostPart[],
): GroundsVerdict {
  return { grounded: false, cause, connectionId, uncovered, lost };
}

function reasonFields(verdict: GroundsVerdict): Record<string, unknown> {
  const parts = verdict.lost.length > 0 ? { lost: partsOf(verdict.lost) } : {};
  if (verdict.grounded) return parts;
  return {
    cause: verdict.cause,
    connection_id: verdict.connectionId,
    uncovered: verdict.uncovered,
    ...parts,
  };
}

/** One side of an audit entry: the derived state, with the reason when orphaned. */
function stateOf(verdict: GroundsVerdict): Record<string, unknown> {
  return { status: verdict.grounded ? 'active' : 'orphaned', ...reasonFields(verdict) };
}
