/**
 * Zod schema for the Policy DSL.
 *
 * Spec : docs/spec/mcp-proxy.md §6.1.
 * ADR  : docs/decisions/policy-dsl-declarative-jsonb.md.
 */

import { z } from 'zod';
import type { Permissions, Rule, Constraint } from '@vauban/shared';

const stringOrNumber = z.union([z.string(), z.number()]);
const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

export const ConstraintSchema: z.ZodType<Constraint> = z.union([
  z.object({ equals: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ in: z.array(stringOrNumber).min(1) }).strict(),
  z.object({ not_in: z.array(stringOrNumber).min(1) }).strict(),
  z.object({ match: z.array(z.string()).min(1) }).strict(),
  z.object({ regex: z.string().min(1) }).strict(),
  z.object({ starts_with: stringOrStringArray }).strict(),
  z.object({ not_starts_with: stringOrStringArray }).strict(),
]);

export const RuleSchema: z.ZodType<Rule> = z
  .object({
    effect: z.enum(['allow', 'deny']),
    target: z.enum(['project.repos', 'project.vercel', 'project.supabase', '*']).optional(),
    tool: z.string().min(1).optional(),
    tool_matches: z.array(z.string().min(1)).min(1).optional(),
    constraints: z.record(z.string(), ConstraintSchema).optional(),
    priority: z.number().int().optional(),
  })
  .strict()
  .refine((r) => r.tool !== undefined || r.tool_matches !== undefined, {
    message: 'rule must define either `tool` or `tool_matches`',
  });

export const PermissionsSchema: z.ZodType<Permissions> = z
  .object({
    version: z.literal(1),
    rules: z.array(RuleSchema).min(1),
  })
  .strict();

export function parsePermissions(input: unknown): Permissions {
  return PermissionsSchema.parse(input);
}

export function safeParsePermissions(
  input: unknown,
): { ok: true; value: Permissions } | { ok: false; error: string } {
  const r = PermissionsSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.message };
}
