/**
 * The admin rule a backup carried (docs/handbook/authentication.md),
 * superseded by the administrators kept in the store (ADR
 * administrators-live-in-the-instance).
 *
 * A copy made by a build between the two carries the source's rule as the key
 * `restored.admin_rule`, JSON `{ "group": "<sign-in provider>:<group>" | null, "emails": [...] }`.
 * Restored on this version, it is read once: while the store names no administrator,
 * the boot applies it with the configuration's own rule (`seedFromConfiguration`);
 * the key is deleted then, or at the first boot that finds administrators. A backup
 * made by this version writes no such key: the administrators are rows of the copy.
 */
import type { AdminRule } from '../config/types';

export const RESTORED_ADMIN_RULE_KEY = 'restored.admin_rule';

/** The carried rule, or `null` when the key is absent or does not parse. */
export function parseRestoredAdminRule(raw: string | null): AdminRule | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { group, emails } = value as Record<string, unknown>;
  if (group !== null && typeof group !== 'string') return null;
  if (!Array.isArray(emails) || !emails.every((e) => typeof e === 'string')) return null;
  return { group, emails: emails.map((e) => e.toLowerCase()) };
}

export function serializeRestoredAdminRule(rule: AdminRule): string {
  return JSON.stringify({ group: rule.group, emails: rule.emails });
}
