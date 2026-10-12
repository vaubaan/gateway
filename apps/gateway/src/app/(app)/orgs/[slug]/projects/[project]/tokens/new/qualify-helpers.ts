/**
 * Small UI-side helper around the mint-form's catalog payload.
 *
 * Why this exists : the form's `MintFormCatalogEntry` is a slimmed-down
 * projection of the full `RiskEntry` (no `matches` string, no full reason
 * metadata, `acceptable_in_envs` narrowed to `readonly[]|null`). The single
 * predicate "is this entry applicable to this binding env ?" lives here so
 * the per-row mapping in `binding-risks-section.tsx` stays readable.
 *
 * Note : `qualifyRiskId` from `@vaubaan/policy-engine` accepts the projected
 * shape directly (it only reads `acceptable_in_envs` — cf. its
 * `QualifiableRiskEntry` parameter type), so callers do NOT need an adapter
 * to pass `MintFormCatalogEntry` through.
 */

import type { MintFormCatalogEntry } from './mint-types';

/** Predicate: "is this catalog entry applicable to this binding env ?" */
export function entryAppliesToBinding(entry: MintFormCatalogEntry, env: string | null): boolean {
  if (entry.deprecated) return false;
  if (!entry.acceptable_in_envs || entry.acceptable_in_envs.length === 0) return true;
  if (env === null) return false;
  return entry.acceptable_in_envs.includes(env);
}
