/**
 * The admin rule (spec §0 "Operator", §4.3): once the bootstrap token is
 * revoked, the operator is any user who belongs to the configured group of a
 * named sign-in provider, or whose email is in the configured list. Evaluated
 * on every check from the user's *current* memberships, never from a snapshot
 * (spec §10).
 *
 * Across several providers (ADR sign-in-providers-admission-and-admin-rule):
 * an email matches the user of any provider (every email a user is recorded
 * with was verified at sign-in, or comes from a tenant provider that sends no
 * verification claim — handbook authentication, "Admission"); a group matches
 * only the members its own provider claimed: a group of provider A never
 * satisfies a rule written for provider B.
 */
import { LEGACY_PROVIDER_ID, resolveAdminGroup, type AdminGroup } from '../config/sign-in';
import type { AdminRule } from '../config/types';
import type { GroupRecord } from '../store/types';

/** The admin rule against the providers configured now. */
export interface ResolvedAdminRule {
  /** The group as written, for the interface; `null` when the rule lists emails only. */
  readonly groupAsWritten: string | null;
  /** The provider's group, or `null` (no group, or one that names no configured provider). */
  readonly group: AdminGroup | null;
  /** Lower-cased. */
  readonly emails: readonly string[];
}

export function resolveAdminRule(
  rule: AdminRule,
  providerIds: readonly string[],
): ResolvedAdminRule {
  // No provider configured (yet, or any more): the rule reads as it did when an
  // instance had one provider, `idp` — the groups it claimed are bound to it.
  const ids = providerIds.length > 0 ? providerIds : [LEGACY_PROVIDER_ID];
  return {
    groupAsWritten: rule.group,
    group: resolveAdminGroup(rule.group, ids),
    emails: rule.emails,
  };
}

export interface AdminRuleSubject {
  readonly email: string;
  /** The user's groups now; only the IdP-sourced ones of the rule's provider count. */
  readonly groups: readonly Pick<GroupRecord, 'name' | 'source' | 'provider'>[];
}

export function isOperator(subject: AdminRuleSubject, rule: ResolvedAdminRule): boolean {
  const group = rule.group;
  if (
    group !== null &&
    subject.groups.some(
      (g) => g.source === 'idp' && g.provider === group.provider && g.name === group.name,
    )
  ) {
    return true;
  }
  return rule.emails.includes(subject.email.toLowerCase());
}

/** The rule as the UI shows it; never a secret. */
export function describeAdminRule(rule: ResolvedAdminRule): string {
  const parts: string[] = [];
  if (rule.group !== null) {
    parts.push(`members of the group "${rule.group.name}" of sign-in provider "${rule.group.provider}"`);
  } else if (rule.groupAsWritten !== null) {
    parts.push(`no group: "${rule.groupAsWritten}" names no configured sign-in provider`);
  }
  if (rule.emails.length > 0) parts.push(`${rule.emails.length} listed email(s)`);
  return parts.join(' or ');
}
