/**
 * Small UI-side helpers around the policy-engine `RiskEntry` shape.
 *
 * Why this exists : the mint-form's catalog payload is a slimmed-down
 * projection of `RiskEntry` (no `matches` string, `acceptable_in_envs`
 * narrowed to readonly|null). `qualifyRiskId` from `@vaubaan/policy-engine`
 * only reads `acceptable_in_envs`, so we adapt the shape with a tiny cast
 * here rather than passing the projected type around.
 */

import type { RiskEntry } from '@vaubaan/shared';

import type { MintFormCatalogEntry } from './mint-types';

/** Predicate: "is this catalog entry applicable to this binding env ?" */
export function entryAppliesToBinding(entry: MintFormCatalogEntry, env: string | null): boolean {
  if (entry.deprecated) return false;
  if (!entry.acceptable_in_envs || entry.acceptable_in_envs.length === 0) return true;
  if (env === null) return false;
  return entry.acceptable_in_envs.includes(env);
}

/** Adapt a `MintFormCatalogEntry` (page-side shape) to a `RiskEntry` shape
 *  for `qualifyRiskId`. The `matches` field is required on `RiskEntry`
 *  but `qualifyRiskId` doesn't read it, so we set an empty string. */
export function asRiskEntry(entry: MintFormCatalogEntry): RiskEntry {
  return {
    id: entry.id,
    label: entry.label,
    reason: entry.reason,
    matches: '',
    vector: entry.vector,
    acceptable_in_envs: entry.acceptable_in_envs ?? undefined,
  };
}
