/**
 * Risk catalog validation + acceptance-time env restriction.
 *
 * Spec : docs/spec/gateway-risk-model.md §4, §9.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * The policy layer has a single structural guardrail : `acceptable_in_envs`
 * on a catalog entry restricts which resource environments can ever accept
 * the risk. There is no project-level override and no 3-gate resolution — a
 * risk is either accepted by the mission (allow) or it isn't (deny at
 * runtime).
 */

import { isRiskId, type RiskCatalog, type RiskEntry } from '@vaubaan/shared';

import { indexCatalog, type IndexedRiskCatalog } from './risk-evaluator.ts';

/**
 * Acceptance-time guard — refuse to accept a risk at issuance if the
 * catalog declares `acceptable_in_envs` and the resource's environment
 * label is not in that list.
 *
 * Returns `null` if OK to accept, or a denial reason string.
 */
export function checkAcceptableInEnv(entry: RiskEntry, env: string | null): string | null {
  if (!entry.acceptable_in_envs) return null;
  if (env === null) {
    return (
      `risk '${entry.id}' restricts acceptance to envs ` +
      `[${entry.acceptable_in_envs.join(', ')}] but the resource has no environment label`
    );
  }
  if (!entry.acceptable_in_envs.includes(env)) {
    return (
      `risk '${entry.id}' is not acceptable in env '${env}' ` +
      `(catalog restricts to [${entry.acceptable_in_envs.join(', ')}])`
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog boot helper
// ─────────────────────────────────────────────────────────────────────────────

export interface PrepareCatalogOptions {
  /** Receives non-fatal findings (missing fallback). Defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

/** Id prefix of the catch-all entry every catalog should declare. */
export function fallbackRiskPrefix(provider: string): string {
  return `${provider}.uncategorized`;
}

/** True iff the catalog declares at least one `<provider>.uncategorized-*` entry. */
export function hasFallbackRisk(catalog: RiskCatalog): boolean {
  const prefix = fallbackRiskPrefix(catalog.provider);
  return catalog.risks.some((entry) => entry.id.startsWith(prefix));
}

/** One-call helper combining `indexCatalog` + sanity checks (ids unique,
 *  RiskId grammar, fallback risk present). Used at boot by the plugin SDK's
 *  catalog loader. */
export function prepareCatalog(
  catalog: RiskCatalog,
  options: PrepareCatalogOptions = {},
): IndexedRiskCatalog {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const indexed = indexCatalog(catalog);
  const ids = new Set<string>();
  for (const { entry } of indexed.entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate risk id '${entry.id}' in catalog '${catalog.provider}'`);
    }
    ids.add(entry.id);
    if (!isRiskId(entry.id)) {
      throw new Error(
        `Risk id '${entry.id}' in catalog '${catalog.provider}' does not match expected format ` +
          `'<provider>[<env>].<name>' or '<provider>.<name>'`,
      );
    }
  }
  // A catalog SHOULD have a fallback risk. The SDK loader turns this into a
  // hard error ; here it stays a warning so partial catalogs can be indexed
  // in tests and tooling.
  if (!hasFallbackRisk(catalog)) {
    warn(
      `[risk-policy] catalog '${catalog.provider}' has no '<provider>.uncategorized-*' fallback ` +
        `risk — concrete slices not matching any catalog entry will silently produce empty ` +
        `risks_touched, which the runtime treats as 'deny' (safe-by-default). Add a fallback.`,
    );
  }
  return indexed;
}
