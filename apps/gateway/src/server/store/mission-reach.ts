/**
 * What a mission reaches on one of its accounts — the one statement of the rule
 * (spec §3.1 "Resource selection"; ADR
 * resource-set-is-one-environment-with-optional-future-resources).
 *
 * A set reaches the ids stored in its list, nothing else: no resource is resolved from
 * the account at call time. A resource that appears later joins a list only by a
 * write (`MissionsRepo.applyResourceChanges`, `addResources`), audited on the mission.
 * Whatever the list says, a *stale* resource (the last discovery no longer returned it)
 * is not reached, and neither is one of the instance's own (`isSelf`, SEC 2026-10-15 H1).
 * A hidden resource in a list stays reached: hiding is a listing preference of the owner.
 *
 * Pure, and in the store on purpose, like `membershipOf`: three readers call it — the
 * execution door (`loadMissionContext`), the mission page (`MissionService.get`) and
 * the bootstrap kit — so the agent is never told it may touch what the door refuses,
 * and a change of the rule cannot be made in one of them and forgotten in another.
 */
import type {
  AccountResourceRecord,
  MissionAccountRecord,
  MissionResourceSetRecord,
} from './types.ts';

type Reachable = Pick<AccountResourceRecord, 'id' | 'staleSince'>;

/** True when one set of the selection takes the resources that later appear in its environment. */
export function takesFutureResources(
  selection: Pick<MissionAccountRecord, 'resourceSets'>,
): boolean {
  return selection.resourceSets.some((set) => set.future);
}

/**
 * The resources of `discovered` (the account's rows, as `listResources` returns
 * them) that each set of the selection reaches now, in the account's own order.
 */
export function reachedResourcesBySet<R extends Reachable>(
  selection: Pick<MissionAccountRecord, 'resourceSets'>,
  discovered: readonly R[],
  isSelf: (resource: R) => boolean,
): Map<string, R[]> {
  const live = (r: R): boolean => r.staleSince === null && !isSelf(r);
  const reach = new Map<string, R[]>();
  for (const set of selection.resourceSets) reach.set(set.id, reachedBySet(set, discovered, live));
  return reach;
}

function reachedBySet<R extends Reachable>(
  set: Pick<MissionResourceSetRecord, 'resourceIds'>,
  discovered: readonly R[],
  live: (r: R) => boolean,
): R[] {
  const selected = new Set(set.resourceIds);
  if (selected.size === 0) return [];
  return discovered.filter((r) => selected.has(r.id) && live(r));
}

/**
 * The resources of `discovered` that the selection reaches now, every set together, in
 * the account's own order.
 */
export function reachedResources<R extends Reachable>(
  selection: Pick<MissionAccountRecord, 'resourceSets'>,
  discovered: readonly R[],
  isSelf: (resource: R) => boolean,
): R[] {
  const reached = new Set(
    [...reachedResourcesBySet(selection, discovered, isSelf).values()].flat().map((r) => r.id),
  );
  return discovered.filter((r) => reached.has(r.id));
}
