import { z } from 'zod';
import type { MissionPolicyEntry } from '@vaubaan/shared';

const whole = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const line = z
  .object({
    risk_id: z.string().min(1).max(300),
    /**
     * The resource set of the line (risk model §4.7). Absent: the set of the line of
     * that risk already in the mission, or, for an addition, the set the answered
     * request names for it, else the first set of its account.
     */
    resource_set_id: z.string().min(1).max(300).optional(),
    quota: whole,
    rate_limit: z.object({ max: whole, window_seconds: whole }).strict(),
    gate: z.enum(['auto', 'approval']),
  })
  .strict();
export const permissionEditSchema = z
  .object({
    policy: z.array(line).max(2000),
    expected_policy: z.array(line).max(2000),
    request_id: z.string().min(1).max(300).optional(),
  })
  .strict();
export type PermissionEdit = z.infer<typeof permissionEditSchema>;

/** Compare the policy rather than a clock timestamp, which can collide. */
export function policyKey(policy: readonly MissionPolicyEntry[]): string {
  return JSON.stringify(
    [...policy]
      .sort(
        (a, b) =>
          a.risk_id.localeCompare(b.risk_id) ||
          (a.resource_set_id ?? '').localeCompare(b.resource_set_id ?? ''),
      )
      .map((p) => [
        p.resource_set_id ?? '',
        p.risk_id,
        p.quota,
        p.rate_limit.max,
        p.rate_limit.window_seconds,
        p.gate,
      ]),
  );
}
