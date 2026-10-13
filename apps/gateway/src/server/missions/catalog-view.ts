/**
 * A provider's catalog as issuance sees it: explicit ids, a severity for
 * ordering, the width of a preset, and whether an env-qualified id can ever
 * be touched with a given resource selection.
 *
 * Pure and browser-safe (the creation form runs the same functions as the
 * server, so the two cannot drift): no IO, values only from
 * `@vaubaan/shared/risk-id` and `@vaubaan/policy-engine`.
 */
import { isEnvScopedEntry, isFallbackEntry, resolveVector } from '@vaubaan/policy-engine';
import type { Preset, RiskCatalog, RiskEntry, RiskId, RiskVector } from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

// The file, not the barrel: `catalog-authority.ts` is pure and browser-safe, the barrel is not.
import { explicitRiskIdsOf } from '../authority/catalog-authority';
import {
  RISK_KINDS,
  type CatalogRisk,
  type IssuanceConnection,
  type IssuanceResource,
  type RiskKind,
  type SeverityLevel,
} from './model';

/**
 * Rank of each axis value, mildest first — the order of `RISK_VECTOR_AXES`
 * in `@vaubaan/shared`, restated here because that constant lives in the
 * server-only barrel. A structural test keeps the two in step.
 */
export const SEVERITY_RANKS: { readonly [K in keyof RiskVector]: readonly RiskVector[K][] } = {
  reversibility: ['reversible', 'costly', 'irreversible'],
  blast: ['single', 'env', 'account', 'bulk'],
  data: ['metadata', 'data', 'secret', 'pii'],
  cost: ['free', 'moderate', 'unbounded'],
  visibility: ['internal', 'team', 'public'],
  persistence: ['stateless', 'session', 'posture'],
};

/** Highest possible `severityOf` (every axis at its worst). */
export const MAX_SEVERITY = Object.values(SEVERITY_RANKS).reduce(
  (sum, values) => sum + values.length - 1,
  0,
);

/**
 * Sum of the axis ranks, 0 (harmless read) to `MAX_SEVERITY`. It orders
 * risks in the interface and names "the most severe one" of a preset; no
 * decision is derived from it (risk model: "no gate is derived from the
 * vector").
 */
export function severityOf(vector: RiskVector): number {
  let score = 0;
  for (const axis of Object.keys(SEVERITY_RANKS) as (keyof RiskVector)[]) {
    const rank = (SEVERITY_RANKS[axis] as readonly string[]).indexOf(vector[axis]);
    score += Math.max(rank, 0);
  }
  return score;
}

export function severityLevel(score: number): SeverityLevel {
  if (score >= 10) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** The patterns of an entry, as a list (the catalog allows one string or several). */
export function patternsOf(entry: Pick<RiskEntry, 'matches'>): readonly string[] {
  return typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
}

/**
 * Read, write or destructive (`RiskKind`). An entry is a read when every one
 * of its patterns ends with the read action; a write that the vector calls
 * irreversible is destructive. A grouping aid for long catalogs: nothing is
 * decided from it.
 */
export function riskKindOf(entry: Pick<RiskEntry, 'matches'>, vector: RiskVector): RiskKind {
  if (patternsOf(entry).every((pattern) => pattern.endsWith('.R'))) return 'read';
  return vector.reversibility === 'irreversible' ? 'destructive' : 'write';
}

/** The display row of one explicit id of `entry` (an id `explicitRiskIdsOf(entry)` returned). */
function riskOf(entry: RiskEntry, provider: string, riskId: RiskId): CatalogRisk {
  const env = isEnvScopedEntry(entry) ? (parseRiskId(riskId)?.env ?? null) : null;
  const vector = resolveVector(entry, env);
  const severity = severityOf(vector);
  return {
    risk_id: riskId,
    base_id: entry.id,
    env,
    label: entry.label,
    reason: entry.reason,
    vector,
    kind: riskKindOf(entry, vector),
    severity,
    level: severityLevel(severity),
    fallback: isFallbackEntry(entry, provider),
    deprecated: entry.deprecated === true,
    rate_ceiling_per_minute: entry.infra_limits?.calls_per_minute_max ?? null,
  };
}

/**
 * The catalog as explicit ids, catalog order: one row per account-scoped
 * entry, one row per acceptable environment of an env-scoped entry. A
 * projection of the authority's enumeration (`explicitRiskIdsOf`, spec §3.1
 * "Enumeration"), with the display fields: the ids a page shows and the ids
 * an authority holds are one list by construction.
 */
export function enumerateCatalog(catalog: RiskCatalog): CatalogRisk[] {
  return catalog.risks.flatMap((entry) =>
    explicitRiskIdsOf(entry).map((riskId) => riskOf(entry, catalog.provider, riskId)),
  );
}

/**
 * Can this id ever be touched with these resources? An account-scoped id
 * always can. An env-qualified id can when the plugin derives the
 * environment from the call itself, or when at least one selected resource
 * carries that environment label (spec §0 "Resource").
 */
export function isResolvable(
  risk: Pick<CatalogRisk, 'env'>,
  connection: Pick<IssuanceConnection, 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): boolean {
  if (risk.env === null) return true;
  if (connection.derives_env) return true;
  return selected.some((r) => r.env === risk.env);
}

export interface PresetWidth {
  readonly risks: number;
  readonly most_severe: {
    readonly risk_id: RiskId;
    readonly label: string;
    readonly level: SeverityLevel;
  } | null;
  readonly largest_quota: number;
  readonly approvals: number;
}

/** The width of a preset (spec §3.2: "how many risks, the most severe one, the largest quota"). */
export function presetWidth(preset: Preset, risks: readonly CatalogRisk[]): PresetWidth {
  let mostSevere: CatalogRisk | null = null;
  let largestQuota = 0;
  let approvals = 0;
  for (const entry of preset.entries) {
    // An entry may name the base id of an env-scoped risk: every env row counts.
    for (const risk of risks) {
      if (risk.risk_id !== entry.risk_id && risk.base_id !== entry.risk_id) continue;
      if (mostSevere === null || risk.severity > mostSevere.severity) mostSevere = risk;
    }
    if (entry.quota > largestQuota) largestQuota = entry.quota;
    if (entry.gate === 'approval') approvals += 1;
  }
  return {
    risks: preset.entries.length,
    most_severe: mostSevere
      ? { risk_id: mostSevere.risk_id, label: mostSevere.label, level: mostSevere.level }
      : null,
    largest_quota: largestQuota,
    approvals,
  };
}

/** One line for the preset picker. */
export function describePresetWidth(width: PresetWidth): string {
  const parts = [`${width.risks} ${width.risks === 1 ? 'risk' : 'risks'}`];
  if (width.most_severe) {
    parts.push(`most severe: ${width.most_severe.label} (${width.most_severe.level})`);
  }
  parts.push(`largest quota ${width.largest_quota}`);
  if (width.approvals > 0) parts.push(`${width.approvals} under approval`);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Explaining a risk: the vector as badges, the groups of a long catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The six axes as the interface names them, with the question each answers
 * (risk model §4.2). The order is the reading order of every badge row and of
 * the legend.
 */
export const VECTOR_AXES: readonly {
  readonly axis: keyof RiskVector;
  readonly label: string;
  /** The axis in a few letters, for the compact strip; the label is its full name. */
  readonly abbr: string;
  readonly question: string;
}[] = [
  {
    axis: 'reversibility',
    label: 'Reversibility',
    abbr: 'Undo',
    question: 'Can it be undone, and at what price?',
  },
  {
    axis: 'blast',
    label: 'Blast radius',
    abbr: 'Blast',
    question: 'How much does one action reach?',
  },
  { axis: 'data', label: 'Data', abbr: 'Data', question: 'What kind of data is exposed?' },
  { axis: 'cost', label: 'Cost', abbr: 'Cost', question: 'Can it spend money?' },
  { axis: 'visibility', label: 'Visibility', abbr: 'Seen', question: 'Who sees the effect?' },
  {
    axis: 'persistence',
    label: 'Persistence',
    abbr: 'Lasts',
    question: 'Does the effect outlive the mission?',
  },
];

/** Where a value sits on its axis: the mildest, the most severe, or in between. */
export type VectorWeight = 'mildest' | 'middle' | 'worst';

export interface VectorBadge {
  readonly axis: keyof RiskVector;
  /** The axis as the interface names it (`Blast radius`). */
  readonly label: string;
  /** The axis in a few letters (`Blast`). */
  readonly abbr: string;
  /** The catalog's value on that axis (`account`). */
  readonly value: string;
  readonly weight: VectorWeight;
  /** The scale of the axis, mildest first: what the badge's tooltip spells out. */
  readonly scale: readonly string[];
}

/** One badge per axis, in the order of `VECTOR_AXES`; the text carries the information. */
export function vectorBadges(vector: RiskVector): VectorBadge[] {
  return VECTOR_AXES.map(({ axis, label, abbr }) => {
    const scale: readonly string[] = SEVERITY_RANKS[axis];
    const rank = scale.indexOf(vector[axis]);
    const weight: VectorWeight =
      rank <= 0 ? 'mildest' : rank === scale.length - 1 ? 'worst' : 'middle';
    return { axis, label, abbr, value: vector[axis], weight, scale };
  });
}

/** How each kind reads as the title of a group, and the one line under it. */
export const RISK_KIND_GROUPS: Readonly<Record<RiskKind, { title: string; hint: string }>> = {
  read: { title: 'Reads', hint: 'Look without changing anything at the service.' },
  write: { title: 'Writes', hint: 'Change something that can be undone, sometimes at a price.' },
  destructive: {
    title: 'Irreversible writes',
    hint: 'Change something the catalog marks as impossible to undo.',
  },
};

/**
 * A catalog entry with the explicit ids it stands for: one variant for an
 * account-scoped entry, one per environment for an env-scoped one. The label
 * and the reason are the entry's; the vector may differ per variant.
 */
export interface RiskFamily {
  readonly base_id: RiskId;
  readonly label: string;
  readonly reason: string;
  readonly fallback: boolean;
  readonly deprecated: boolean;
  readonly variants: readonly CatalogRisk[];
}

/** The rows grouped by catalog entry, catalog order kept. */
export function groupVariants(risks: readonly CatalogRisk[]): RiskFamily[] {
  const families = new Map<RiskId, CatalogRisk[]>();
  for (const risk of risks) {
    const variants = families.get(risk.base_id);
    if (variants) variants.push(risk);
    else families.set(risk.base_id, [risk]);
  }
  return [...families.entries()].flatMap(([base_id, variants]) => {
    const [first] = variants;
    if (!first) return [];
    return [
      {
        base_id,
        label: first.label,
        reason: first.reason,
        fallback: first.fallback,
        deprecated: first.deprecated,
        variants,
      },
    ];
  });
}

export interface RiskKindGroup {
  readonly kind: RiskKind;
  readonly title: string;
  readonly hint: string;
  readonly families: readonly RiskFamily[];
}

/**
 * The rows as the granular editor and the provider reference list them:
 * reads, then writes, then irreversible writes; inside a group, one family
 * per catalog entry in catalog order. Empty groups are left out. An env-scoped
 * entry whose vector turns irreversible in one environment only appears in
 * two groups, each with the variants that belong there.
 */
export function groupByKind(risks: readonly CatalogRisk[]): RiskKindGroup[] {
  return RISK_KINDS.map((kind) => ({
    kind,
    ...RISK_KIND_GROUPS[kind],
    families: groupVariants(risks.filter((risk) => risk.kind === kind)),
  })).filter((group) => group.families.length > 0);
}

/** What the two catalog markers mean, wherever one is shown (risk model §4.3, §4.5). */
export const FALLBACK_NOTE =
  'Fallback: counts only for a write no other entry of the catalog names. Accepting it accepts writes nobody reviewed; no preset includes it.';
export const DEPRECATED_NOTE =
  'Deprecated: kept so that existing missions and shares keep working; "select all" and presets leave it out.';

/**
 * A note without its lead ("Fallback: counts only…" → "Counts only…"), for the
 * places that already print the lead as a title or a badge.
 */
export function noteBody(note: string): string {
  const body = note.replace(/^[^:]{1,40}: /, '');
  return body.charAt(0).toUpperCase() + body.slice(1);
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** A rate limit in a few characters: `120/min`, `10/hour`, `5 per 30s`. */
export function formatRate(rate: {
  readonly max: number;
  readonly window_seconds: number;
}): string {
  if (rate.window_seconds === SECONDS_PER_MINUTE) return `${rate.max}/min`;
  if (rate.window_seconds === SECONDS_PER_HOUR) return `${rate.max}/hour`;
  if (rate.window_seconds === 1) return `${rate.max}/s`;
  return `${rate.max} per ${rate.window_seconds}s`;
}
