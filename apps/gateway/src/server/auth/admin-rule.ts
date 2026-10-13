/**
 * The admin rule (spec §0 "Operator", §4.3): once the bootstrap token is
 * revoked, the operator is any user who belongs to the configured IdP group
 * or whose email is in the configured list. Evaluated on every check from
 * the user's *current* memberships, never from a snapshot (spec §10).
 */
import type { AdminRule } from '../config/types';

export interface AdminRuleSubject {
  readonly email: string;
  readonly groupNames: readonly string[];
}

export function isOperator(subject: AdminRuleSubject, rule: AdminRule): boolean {
  if (rule.group !== null && subject.groupNames.includes(rule.group)) return true;
  return rule.emails.includes(subject.email.toLowerCase());
}

/** The rule as the UI shows it; never a secret. */
export function describeAdminRule(rule: AdminRule): string {
  const parts: string[] = [];
  if (rule.group !== null) parts.push(`members of the IdP group "${rule.group}"`);
  if (rule.emails.length > 0) parts.push(`${rule.emails.length} listed email(s)`);
  return parts.join(' or ');
}
