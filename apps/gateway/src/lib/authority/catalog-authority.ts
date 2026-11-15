/**
 * The explicit enumeration of a service's catalog (spec §3.1 "Enumeration":
 * no stage expresses "everything").
 *
 * An account-scoped entry contributes its id (`github.merge-protected`); an
 * env-scoped entry contributes one id per environment it is acceptable in
 * (`supabase[staging].bulk-row-write`, `supabase[preview].bulk-row-write`).
 * That list is what "the service's full catalog" means wherever an authority
 * is written down, and it is exactly the set of ids the store's catalog index
 * accepts (`RegistryCatalogIndex.has`).
 *
 * Pure and browser-safe: values come from `@vaubaan/shared/risk-id`, never
 * from the server-only barrel.
 */
import { isEnvScopedEntry } from '@vaubaan/policy-engine';
import type { RiskCatalog, RiskEntry, RiskId } from '@vaubaan/shared';
import { formatRiskId, parseRiskId } from '@vaubaan/shared/risk-id';

/** The explicit ids one catalog entry stands for, in the order of `acceptable_in_envs`. */
export function explicitRiskIdsOf(entry: RiskEntry): RiskId[] {
  if (!isEnvScopedEntry(entry)) return [entry.id];
  const parsed = parseRiskId(entry.id);
  if (!parsed) return [];
  return (entry.acceptable_in_envs ?? []).map((env) =>
    formatRiskId({ service: parsed.service, env, name: parsed.name }),
  );
}

/** Every explicit `RiskId` of a catalog, in catalog order. Never a wildcard. */
export function fullCatalogRiskIds(catalog: RiskCatalog): RiskId[] {
  return catalog.risks.flatMap(explicitRiskIdsOf);
}

/**
 * The ids of `requested` an authority does not cover, in request order (spec §3.1
 * "Monotonicity"). The one spelling of "asked minus held": issuance sorts a draft's
 * lines with it (`missions/preview.ts`) and the re-check of a mission's grounds
 * names what a share no longer covers with it (`AuthorityRecheck.gapsOf`).
 */
export function uncoveredRisks(
  authority: { readonly riskIds: readonly RiskId[] },
  requested: readonly RiskId[],
): RiskId[] {
  const held = new Set(authority.riskIds);
  return requested.filter((id) => !held.has(id));
}
