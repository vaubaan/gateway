/**
 * An edit of a mission in words (ADR mission-editable-after-issuance): what the
 * mission's activity, the request timeline and the audit say of a
 * `mission-changed` session event. Pure, no import but the event's shape, so the
 * pages and the server read it alike.
 */
import type { MissionChangedEventDetails } from '@vaubaan/shared';

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The clauses of an edit, in the interface's words: "renamed", "2 resources added",
 * "1 permission removed", "quota of github.read 200 → 500". Total over any summary.
 */
export function missionChangeClauses(summary: MissionChangedEventDetails): string[] {
  const clauses: string[] = [];
  if (summary.name_changed) clauses.push('renamed');
  if (summary.expiry_changed) {
    clauses.push(
      summary.expires_at
        ? `end date set to ${summary.expires_at.slice(0, 10)}`
        : 'end date removed',
    );
  }
  if (summary.connections_added > 0) {
    clauses.push(`${counted(summary.connections_added, 'account', 'accounts')} added`);
  }
  if (summary.connections_removed > 0) {
    clauses.push(`${counted(summary.connections_removed, 'account', 'accounts')} removed`);
  }
  const setsAdded = summary.resource_sets_added ?? 0;
  if (setsAdded > 0) {
    clauses.push(`${counted(setsAdded, 'resource set', 'resource sets')} added`);
  }
  const setsRemoved = summary.resource_sets_removed ?? 0;
  if (setsRemoved > 0) {
    clauses.push(`${counted(setsRemoved, 'resource set', 'resource sets')} removed`);
  }
  if (summary.resources_added > 0) {
    clauses.push(`${counted(summary.resources_added, 'resource', 'resources')} added`);
  }
  if (summary.resources_removed > 0) {
    clauses.push(`${counted(summary.resources_removed, 'resource', 'resources')} removed`);
  }
  if (summary.scopes_changed > 0) {
    clauses.push(`reach of ${counted(summary.scopes_changed, 'account', 'accounts')} changed`);
  }
  if (summary.permissions_added.length > 0) {
    clauses.push(`${counted(summary.permissions_added.length, 'permission', 'permissions')} added`);
  }
  if (summary.permissions_removed.length > 0) {
    clauses.push(
      `${counted(summary.permissions_removed.length, 'permission', 'permissions')} removed`,
    );
  }
  for (const limit of summary.limits) {
    if (limit.quota !== limit.quota_before) {
      clauses.push(`quota of ${limit.risk_id} ${limit.quota_before} → ${limit.quota}`);
    }
    if (
      limit.rate_limit_max !== limit.rate_limit_max_before ||
      limit.rate_window_seconds !== limit.rate_window_seconds_before
    ) {
      clauses.push(
        `rate of ${limit.risk_id} ${limit.rate_limit_max_before}/${limit.rate_window_seconds_before}s → ${limit.rate_limit_max}/${limit.rate_window_seconds}s`,
      );
    }
  }
  for (const gate of summary.gates) {
    clauses.push(
      gate.gate === 'approval'
        ? `${gate.risk_id} now asks first`
        : `${gate.risk_id} now runs freely`,
    );
  }
  if (summary.requests_closed > 0) {
    clauses.push(`${counted(summary.requests_closed, 'request', 'requests')} closed`);
  }
  return clauses;
}

/** "Changed the mission: 2 resources added, 1 permission removed, quota of github.read 200 → 500". */
export function describeMissionChange(summary: MissionChangedEventDetails): string {
  const clauses = missionChangeClauses(summary);
  return clauses.length === 0
    ? 'Changed the mission'
    : `Changed the mission: ${clauses.join(', ')}`;
}
