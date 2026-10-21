/**
 * Test doubles of the authority module. Test files only.
 */
import type { MissionGrounds } from './mission-grounds';

/**
 * `MissionGrounds` for a fixture that has no connection, share or group to
 * read (a budget or request test over a bare store): every mission is
 * grounded, so its stored status is the one the reader sees. A test about
 * `orphaned` uses the real module (`createAuthorityModule`).
 */
export const alwaysGrounded: Pick<MissionGrounds, 'inspect' | 'derive'> = {
  inspect: async (mission) => ({ mission, orphan: null, lost: [] }),
  derive: async (mission) => mission,
};
