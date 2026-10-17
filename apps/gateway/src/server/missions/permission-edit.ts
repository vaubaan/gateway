import { z } from 'zod';
import type { MissionPolicyEntry } from '@vaubaan/shared';

const whole = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const line = z
  .object({
    risk_id: z.string().min(1).max(300),
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
      .sort((a, b) => a.risk_id.localeCompare(b.risk_id))
      .map((p) => [p.risk_id, p.quota, p.rate_limit.max, p.rate_limit.window_seconds, p.gate]),
  );
}
