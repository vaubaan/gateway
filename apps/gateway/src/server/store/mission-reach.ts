/**
 * What a mission reaches on one of its connections — the one statement of the rule
 * (spec §3.1 "Resource selection"; ADR mission-reaches-the-whole-connection-on-request).
 *
 *   selected    the ids stored at issuance that discovery still returns
 *   all         nothing: no resource was known at issuance (an empty stored list)
 *   connection  every resource discovery returns now — known at issuance or discovered
 *               later — except the ones the owner hid and the ones another resource
 *               set of the connection selects (risk model §4.7)
 *
 * Each resource set of a connection has one scope; the connection's reach is the union.
 * Whatever the scope, a *stale* resource (the last discovery no longer returned it) is
 * not reached, and neither is one of the instance's own (`isSelf`, SEC 2026-10-15 H1).
 * A hidden resource selected on purpose stays reached: hiding is a listing preference
 * of the owner; under `connection` it keeps a resource out of "everything".
 *
 * Pure, and in the store on purpose, like `membershipOf`: three readers call it — the
 * execution door (`loadMissionContext`), the mission page (`MissionService.get`) and
 * the bootstrap kit — so the agent is never told it may touch what the door refuses,
 * and a change of the rule cannot be made in one of them and forgotten in another.
 */
import type {
  ConnectionResourceRecord,
  MissionConnectionRecord,
  MissionResourceSetRecord,
} from './types.ts';

type Reachable = Pick<ConnectionResourceRecord, 'id' | 'hidden' | 'staleSince'>;

/** True when one set of the selection reaches resources discovered after issuance. */
export function reachesLaterResources(
  selection: Pick<MissionConnectionRecord, 'resourceSets'>,
): boolean {
  return selection.resourceSets.some((set) => set.resourceScope === 'connection');
}

/**
 * The resources of `discovered` (the connection's rows, as `listResources` returns
 * them) that each set of the selection reaches now, in the connection's own order. The
 * sets partition the reach (risk model §4.7): a set of scope `connection` reaches what
 * no other set of the connection selects.
 */
export function reachedResourcesBySet<R extends Reachable>(
  selection: Pick<MissionConnectionRecord, 'resourceSets'>,
  discovered: readonly R[],
  isSelf: (resource: R) => boolean,
): Map<string, R[]> {
  const live = (r: R): boolean => r.staleSince === null && !isSelf(r);
  const elsewhere = new Set(selection.resourceSets.flatMap((set) => set.resourceIds));
  const reach = new Map<string, R[]>();
  for (const set of selection.resourceSets) {
    reach.set(set.id, reachedBySet(set, discovered, live, elsewhere));
  }
  return reach;
}

function reachedBySet<R extends Reachable>(
  set: Pick<MissionResourceSetRecord, 'resourceScope' | 'resourceIds'>,
  discovered: readonly R[],
  live: (r: R) => boolean,
  elsewhere: ReadonlySet<string>,
): R[] {
  if (set.resourceScope === 'connection') {
    return discovered.filter((r) => !r.hidden && !elsewhere.has(r.id) && live(r));
  }
  const selected = new Set(set.resourceIds);
  if (selected.size === 0) return [];
  return discovered.filter((r) => selected.has(r.id) && live(r));
}

/**
 * The resources of `discovered` that the selection reaches now, every set together, in
 * the connection's own order.
 */
export function reachedResources<R extends Reachable>(
  selection: Pick<MissionConnectionRecord, 'resourceSets'>,
  discovered: readonly R[],
  isSelf: (resource: R) => boolean,
): R[] {
  const reached = new Set(
    [...reachedResourcesBySet(selection, discovered, isSelf).values()].flat().map((r) => r.id),
  );
  return discovered.filter((r) => reached.has(r.id));
}
