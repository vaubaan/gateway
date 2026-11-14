/**
 * A provider's catalog as issuance sees it: explicit ids, a row and its
 * reason for ordering (worst first), and whether an env-qualified id can ever
 * be touched with a given resource selection.
 *
 * Pure and browser-safe (the creation form runs the same functions as the
 * server, so the two cannot drift): no IO, values only from
 * `@vaubaan/shared/risk-id` and `@vaubaan/policy-engine`.
 */
import {
  isEnvScopedEntry,
  isFallbackEntry,
  reasonOf,
  resolveVector,
  rowOf,
} from '@vaubaan/policy-engine';
import type { RiskCatalog, RiskEntry, RiskId, RiskVector } from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

// The file, not the barrel: `catalog-authority.ts` is pure and browser-safe, the barrel is not.
import { explicitRiskIdsOf } from '../authority/catalog-authority';
import {
  RISK_KINDS,
  type CatalogRisk,
  type IssuanceAccount,
  type IssuanceResource,
  type RiskKind,
} from './model';
import { SECONDS_PER_MINUTE } from '@vaubaan/shared/time';

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
  return {
    risk_id: riskId,
    base_id: entry.id,
    env,
    label: entry.label,
    reason: entry.reason,
    vector,
    kind: riskKindOf(entry, vector),
    row: rowOf(vector),
    row_reason: reasonOf(vector),
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
 * The environment labels the catalog knows: the environments its env-scoped
 * risks are acceptable in, in catalog order. What an account's owner may
 * choose as its default environment (ADR connect-driver-and-resource-curation);
 * empty for a catalog without env-scoped risks.
 */
export function catalogEnvsOf(catalog: RiskCatalog): string[] {
  return [
    ...new Set(enumerateCatalog(catalog).flatMap((risk) => (risk.env === null ? [] : [risk.env]))),
  ];
}

/**
 * Can this id ever be touched with these resources? An account-scoped id
 * always can. An env-qualified id can when the plugin derives the
 * environment from the call itself, or when at least one selected resource
 * carries that environment label (spec §0 "Resource").
 */
export function isResolvable(
  risk: Pick<CatalogRisk, 'env'>,
  account: Pick<IssuanceAccount, 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): boolean {
  if (risk.env === null) return true;
  if (account.derives_env) return true;
  return selected.some((r) => r.env === risk.env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering and grouping a catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worst row first, then catalog order: how a list of permissions is ordered
 * wherever it is ranked (risk model §4.6). `Array.prototype.sort` is stable,
 * so ties keep the order they came in.
 */
export function byRowWorstFirst<T extends Pick<CatalogRisk, 'row'>>(risks: readonly T[]): T[] {
  return [...risks].sort((a, b) => b.row - a.row);
}

/** The permission in the hardest row to repair, the first in catalog order on a tie; `null` for none. */
export function hardestToRepair<T extends Pick<CatalogRisk, 'row'>>(risks: readonly T[]): T | null {
  return byRowWorstFirst(risks)[0] ?? null;
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
  'Fallback: counts only for a write no other entry of the catalog names. Accepting it accepts writes nobody reviewed; only "Anything else" includes it.';
export const DEPRECATED_NOTE =
  'Deprecated: kept so that existing missions and shares keep working; "select all" and macro-actions leave it out.';

/**
 * A note without its lead ("Fallback: counts only…" → "Counts only…"), for the
 * places that already print the lead as a title or a badge.
 */
export function noteBody(note: string): string {
  const body = note.replace(/^[^:]{1,40}: /, '');
  return body.charAt(0).toUpperCase() + body.slice(1);
}

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
