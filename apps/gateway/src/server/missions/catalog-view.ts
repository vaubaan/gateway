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
import type { CatalogRisk, IssuanceConnection, IssuanceResource, SeverityLevel } from './model';

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

/** The display row of one explicit id of `entry` (an id `explicitRiskIdsOf(entry)` returned). */
function riskOf(entry: RiskEntry, provider: string, riskId: RiskId): CatalogRisk {
  const env = isEnvScopedEntry(entry) ? (parseRiskId(riskId)?.env ?? null) : null;
  const severity = severityOf(resolveVector(entry, env));
  return {
    risk_id: riskId,
    base_id: entry.id,
    env,
    label: entry.label,
    reason: entry.reason,
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
