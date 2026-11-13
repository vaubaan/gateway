/**
 * The three-line summary of a mission (spec §4.2): what it can do, what it
 * cannot do, in what quantity. The creator reads these three lines instead of
 * a wall of checkboxes and unfolds the per-risk detail only to adjust.
 *
 * Pure and browser-safe. The same text is returned by `preview()` and shown
 * live by the creation form.
 */
import { ratePerMinute, ROW_WORDS } from '@vaubaan/policy-engine';

import { byRowWorstFirst, hardestToRepair } from './catalog-view';
import type {
  CatalogRisk,
  ConnectionPreview,
  DraftPeriod,
  IssuanceConnection,
  MissionSummaryLines,
} from './model';

/** Longest risk label a summary line quotes in full; the rest is cut with an ellipsis. */
const LABEL_MAX = 44;

const SECONDS = { hour: 3600, day: 86_400, week: 604_800 } as const;

export interface SummaryInput {
  /** The issuance connections, index-aligned with `previews`. */
  readonly connections: readonly IssuanceConnection[];
  readonly previews: readonly ConnectionPreview[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
}

/** A risk label short enough for a one-line summary. */
export function shortLabel(label: string): string {
  if (label.length <= LABEL_MAX) return label;
  return `${label.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "per day", "per hour", "every 90 minutes", or "in total" for a one-off mission. */
export function periodPhrase(period: DraftPeriod): string {
  if (period.kind === 'one-off') return 'in total';
  const s = period.length_seconds;
  if (s === SECONDS.hour) return 'per hour';
  if (s === SECONDS.day) return 'per day';
  if (s === SECONDS.week) return 'per week';
  if (s % SECONDS.day === 0) return `every ${s / SECONDS.day} days`;
  if (s % SECONDS.hour === 0) return `every ${s / SECONDS.hour} hours`;
  return `every ${Math.round(s / 60)} minutes`;
}

export function reloadPhrase(period: DraftPeriod): string {
  if (period.kind === 'one-off') return 'quotas never reload (one-off)';
  return `quotas reload ${periodPhrase(period).replace(/^per /, 'every ')}`;
}

export function expiryPhrase(expiresAt: string | null): string {
  if (expiresAt === null) return 'never expires';
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return 'expiry not set';
  return `expires ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A row in words, as a summary sentence quotes it: "(cannot be repaired)". */
function rowPhrase(risk: Pick<CatalogRisk, 'row'>): string {
  return ROW_WORDS[risk.row].toLowerCase();
}

function canLine(connection: IssuanceConnection, preview: ConnectionPreview): string | null {
  if (preview.passes.length === 0) return null;
  const byId = new Map(connection.risks.map((r) => [r.risk_id, r]));
  // A risk accepted in several resource sets is one risk of the account.
  const accepted = [...new Set(preview.passes.map((p) => p.risk_id))].flatMap(
    (id) => byId.get(id) ?? [],
  );
  const top = hardestToRepair(accepted);
  const later = preview.future ? ', resources found later included' : '';
  const where =
    preview.resources_total === 0
      ? `the account${later}`
      : `${preview.resources.length} of ${plural(preview.resources_total, 'resource')}${later}`;
  const upTo = top ? `, up to "${shortLabel(top.label)}" (${rowPhrase(top)})` : '';
  return `${connection.provider_label} "${connection.display_name}": ${plural(
    accepted.length,
    'risk',
  )} on ${where}${upTo}`;
}

function cannotLine(connection: IssuanceConnection, preview: ConnectionPreview): string {
  const accepted = new Set(preview.passes.map((p) => p.risk_id));
  const held = new Set(connection.authority);
  const withheld = byRowWorstFirst(
    connection.risks.filter(
      (r) => held.has(r.risk_id) && !accepted.has(r.risk_id) && !r.deprecated,
    ),
  );
  const parts: string[] = [];
  const [worst] = withheld;
  if (!worst) {
    parts.push('every risk you hold is accepted');
  } else {
    parts.push(
      `${plural(withheld.length, 'risk')} withheld, the hardest to repair "${shortLabel(worst.label)}" (${rowPhrase(worst)})`,
    );
  }
  const leftOut = preview.resources_total - preview.resources.length;
  if (leftOut > 0) parts.push(`${plural(leftOut, 'resource')} left out`);
  return `${connection.provider_label}: ${parts.join('; ')}`;
}

function quantitiesLine(input: SummaryInput): string {
  const entries = input.previews.flatMap((p) => p.passes);
  if (entries.length === 0) return 'No budget yet.';
  const labels = new Map(
    input.connections.flatMap((c) => c.risks.map((r) => [r.risk_id, r.label] as const)),
  );
  let largest = entries[0]!;
  let fastest = entries[0]!;
  let approvals = 0;
  for (const entry of entries) {
    if (entry.quota > largest.quota) largest = entry;
    if (ratePerMinute(entry.rate_limit) > ratePerMinute(fastest.rate_limit)) fastest = entry;
    if (entry.gate === 'approval') approvals += 1;
  }
  const parts = [
    `At most ${largest.quota} actions ${periodPhrase(input.period)} on the widest risk ("${shortLabel(
      labels.get(largest.risk_id) ?? largest.risk_id,
    )}")`,
    `fastest ${fastest.rate_limit.max} per ${fastest.rate_limit.window_seconds}s`,
    approvals === 0
      ? 'no approval gate'
      : `${plural(approvals, 'risk')} need${approvals === 1 ? 's' : ''} your approval for each action`,
    reloadPhrase(input.period),
    expiryPhrase(input.expires_at),
  ];
  return `${parts.join(' · ')}.`;
}

export function summarize(input: SummaryInput): MissionSummaryLines {
  const can: string[] = [];
  const cannot: string[] = [];
  input.previews.forEach((preview, i) => {
    const connection = input.connections[i];
    if (!connection) return;
    const line = canLine(connection, preview);
    if (line) can.push(line);
    cannot.push(cannotLine(connection, preview));
  });
  return {
    can:
      can.length === 0
        ? 'Nothing yet — include a connection and tick a macro-action.'
        : `${can.join(' · ')}.`,
    cannot:
      cannot.length === 0
        ? 'Everything: no connection is included.'
        : `${cannot.join(' · ')}. Anything outside the selected resources and the accepted risks is refused.`,
    quantities: quantitiesLine(input),
  };
}
