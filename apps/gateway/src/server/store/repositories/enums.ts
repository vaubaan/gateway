/**
 * The closed sets of the enum columns whose union type is defined outside the store
 * (`@vaubaan/shared`, `@vaubaan/gateway-core`), as lists the row mappers hand to
 * `parseEnum`.
 *
 * Those packages export the unions as types only (`GATES` is the one exception), so the
 * lists are written here from the unions: `membersOf` makes a member added to or removed
 * from a union a compile error on the matching list. They belong next to their types
 * (`packages/shared/src/domain.ts`, `packages/gateway-core/src/audit.ts`), with the
 * unions derived from them; once they are exported from there, this file re-exports them.
 * The sets the store itself owns are `as const` lists in `../types.ts`.
 */

import type { AdminAct, AdminObjectType, AuditDecision, AuditEntry } from '@vaubaan/gateway-core';
import { GATES } from '@vaubaan/shared';
import type {
  GroupSource,
  MissionStatus,
  RequestKind,
  RequestState,
  ShareStatus,
} from '../types.ts';

/** The members of a closed union; the argument must name each member exactly once. */
function membersOf<T extends string>(members: Record<T, true>): readonly T[] {
  return Object.keys(members) as T[];
}

export { GATES };

export const GROUP_SOURCES = membersOf<GroupSource>({ idp: true, local: true });

export const SHARE_STATUSES = membersOf<ShareStatus>({ active: true, revoked: true });

export const MISSION_STATUSES = membersOf<MissionStatus>({
  active: true,
  expired: true,
  orphaned: true,
  revoked: true,
});

/**
 * What `missions.status` may hold. `orphaned` is derived from the creator's current
 * authority on every read (`MissionGrounds`), never stored: a row that carried it would
 * fail to parse, and the triggers of migration 0007 refuse the write.
 */
export const STORED_MISSION_STATUSES = membersOf<Exclude<MissionStatus, 'orphaned'>>({
  active: true,
  expired: true,
  revoked: true,
});

export const REQUEST_KINDS = membersOf<RequestKind>({ claim: true, approval: true });

export const REQUEST_STATES = membersOf<RequestState>({
  open: true,
  granted: true,
  refused: true,
  expired: true,
});

export const AUDIT_KINDS = membersOf<AuditEntry['kind']>({ call: true, admin: true });

export const AUDIT_DECISIONS = membersOf<AuditDecision>({ allowed: true, refused: true });

export const ADMIN_ACTS = membersOf<AdminAct>({
  'connection-created': true,
  'connection-reconnected': true,
  'connection-refused': true,
  'connection-transferred': true,
  'connection-reassigned': true,
  'connection-revoked': true,
  'resources-discovered': true,
  'resource-edited': true,
  'share-created': true,
  'share-revoked': true,
  'mission-issued': true,
  'mission-rotated': true,
  'mission-revoked': true,
  'mission-member-added': true,
  'mission-member-removed': true,
  'mission-member-left': true,
  'mission-token-issued': true,
  'mission-token-revoked': true,
  'mission-closed': true,
  'mission-orphaned': true,
  'mission-restored': true,
  'budget-extended': true,
  'period-reset': true,
  'expiry-extended': true,
  'gate-opened': true,
  'gate-changed': true,
  'limits-changed': true,
  'approval-granted': true,
  'request-refused': true,
  'delegation-granted': true,
  'delegation-revoked': true,
  'group-created': true,
  'group-member-added': true,
  'group-member-removed': true,
  'oauth-client-approved': true,
  'oauth-client-disabled': true,
  'user-deactivated': true,
  'user-reactivated': true,
  'config-changed': true,
});

export const ADMIN_OBJECT_TYPES = membersOf<AdminObjectType>({
  connection: true,
  share: true,
  mission: true,
  request: true,
  delegation: true,
  group: true,
  'oauth-client': true,
  user: true,
  'instance-config': true,
});
