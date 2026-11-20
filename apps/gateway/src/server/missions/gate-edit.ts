/** Whether a creator may still set a mission's gates (`mission-service.ts`, `mission-edits.ts`). */
import type { MissionRecord } from '../store/types';

/**
 * The statuses on which a mission's gates are not edited: the ones from which it does
 * not come back by itself (spec §2.3). `status` is the derived one, so the edit is
 * open again as soon as an orphaned mission's authority is back. An EXPIRED mission is
 * not in the list: its creator can extend the expiry (a claim's `extend-expiry`), and
 * the gates they set meanwhile are the ones it serves with again. `setGate` refuses on
 * it and the mission page reads it from `MissionDetail.gates_editable`.
 */
export function gateEditBlockedBy(
  mission: Pick<MissionRecord, 'status'>,
): 'revoked' | 'orphaned' | null {
  return mission.status === 'revoked' || mission.status === 'orphaned' ? mission.status : null;
}
