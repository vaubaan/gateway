/**
 * Who a user is to a mission — the one statement of the rule (spec §0 "Mission
 * member"; ADR mission-members-and-per-holder-tokens).
 *
 *   creator       created the mission: a member by construction, with no row. Their
 *                 own status is not judged here — a deactivated creator orphans the
 *                 mission (`MissionGrounds`), which is the mission's state, not theirs
 *   member        an active user with a member row that is not removed
 *   deactivated   holds (or held) a row, and an operator deactivated them
 *   removed       an active user whose row was removed
 *   none          never on the mission
 *
 * Pure, and in the store on purpose: three decisions read it — who may READ the
 * mission (`MissionService.access`), whose Bearer AUTHENTICATES at the execution door
 * (`MissionService.standingOf`), and for whom a token may be INSERTED
 * (`MissionsRepo.issueToken`, inside its transaction, which no service can reach
 * into). One function, so a change to what a member is cannot be made in one of the
 * three and forgotten in another.
 */
import type { MissionMemberRecord, MissionRecord, UserRecord } from './types.ts';

export const MEMBERSHIPS = ['creator', 'member', 'deactivated', 'removed', 'none'] as const;
export type Membership = (typeof MEMBERSHIPS)[number];

export function membershipOf(
  mission: Pick<MissionRecord, 'creatorUserId'>,
  userId: string,
  /** The user's row; `null` when the instance does not know them. */
  user: Pick<UserRecord, 'status'> | null,
  /** Their member row on this mission, removed or not; `null` when there is none. */
  row: Pick<MissionMemberRecord, 'removedAt'> | null,
): Membership {
  if (mission.creatorUserId === userId) return 'creator';
  // Deactivation is told before removal: it is the wider fact about the person.
  if (user?.status !== 'active') return row ? 'deactivated' : 'none';
  if (!row) return 'none';
  return row.removedAt === null ? 'member' : 'removed';
}

/** May this user work on the mission now — read it, hold a token of it? */
export function isOnMission(membership: Membership): boolean {
  return membership === 'creator' || membership === 'member';
}
