/**
 * What a mission reaches on one of its connections — the one statement of the rule
 * (spec §3.1 "Resource selection"; ADR mission-reaches-the-whole-connection-on-request).
 *
 *   selected    the ids stored at issuance that discovery still returns
 *   all         nothing: no resource was known at issuance (an empty stored list)
 *   connection  every resource discovery returns now — known at issuance or discovered
 *               later — except the ones the owner hid
 *
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
import type { ConnectionResourceRecord, MissionConnectionRecord } from './types.ts';

type Reachable = Pick<ConnectionResourceRecord, 'id' | 'hidden' | 'staleSince'>;

/** True when the selection reaches resources discovered after issuance. */
export function reachesLaterResources(
  selection: Pick<MissionConnectionRecord, 'resourceScope'>,
): boolean {
  return selection.resourceScope === 'connection';
}

/**
 * The resources of `discovered` (the connection's rows, as `listResources` returns
 * them) that the selection reaches now, in the connection's own order.
 */
export function reachedResources<R extends Reachable>(
  selection: Pick<MissionConnectionRecord, 'resourceScope' | 'resourceIds'>,
  discovered: readonly R[],
  isSelf: (resource: R) => boolean,
): R[] {
  const live = (r: R): boolean => r.staleSince === null && !isSelf(r);
  if (reachesLaterResources(selection)) return discovered.filter((r) => !r.hidden && live(r));
  const selected = new Set(selection.resourceIds);
  if (selected.size === 0) return [];
  return discovered.filter((r) => selected.has(r.id) && live(r));
}
