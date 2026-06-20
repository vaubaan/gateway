/**
 * Risk runtime — the per-call authorization decision.
 *
 * Spec : docs/spec/gateway-risk-model.md §8 (strict-fail MVP).
 *
 *   1. plugin.classify(tool, args) → slices[]
 *   2. risks_touched = ∪_{slice ∈ slices} risksTouchedBy(slice, catalog)
 *   3. if risks_touched ⊆ token.accepted_risks → ALLOW
 *      else                                    → DENY (with missing_risks)
 *   4. audit_log.insert(slices, risks_touched, decision, ...)
 *
 * The runtime is **stateless** w.r.t. the project policy : the gate
 * resolution happened at mint time (the token would not exist if a
 * `confirm` was not approved or a `deny` were involved). At call time we
 * only intersect the slice with the catalog and check set membership.
 */

import type { ProviderBinding, RiskCatalog, RiskDecision, RiskId, Slice } from '@vaubaan/shared';

import {
  findRiskEntry,
  indexCatalog,
  risksTouchedBy,
  type IndexedRiskCatalog,
} from './risk-evaluator.ts';
import { qualifyRiskId, resolveSliceBindingEnv } from './qualify.ts';
import { serializeSlice } from './slice-dsl.ts';

export interface EvaluateCallInput {
  /** The concrete slice(s) the plugin classified for this call. */
  readonly executed_slices: readonly Slice[];
  /** The token's accepted risks — its authorization scope. */
  readonly token_accepted_risks: ReadonlySet<RiskId>;
  /** The token's explicit denials (opt-outs). */
  readonly token_denied_risks?: ReadonlySet<RiskId>;
  /** The indexed catalog of the provider in question. */
  readonly catalog: IndexedRiskCatalog;
  /** Bindings on the access token. Used to resolve each slice's env so the
   *  runtime can env-qualify the touched risks (e.g.
   *  `supabase.bulk-row-write` → `supabase[staging].bulk-row-write`) before
   *  the subset check against `token_accepted_risks` (which are stored
   *  qualified per the mint UX, cf. spec §4.4). When omitted, risks_touched
   *  are returned non-qualified — useful for tests that don't model envs. */
  readonly bindings?: ReadonlyArray<ProviderBinding>;
}

/**
 * Stateless per-call decision. Pure function — no IO. Returns a
 * structured `RiskDecision` ready for audit logging and HTTP response.
 *
 * The hot-path inside the gateway is :
 *
 *   const decision = evaluateCall({
 *     executed_slices: plugin.classifyV4(tool, args, bindings),
 *     token_accepted_risks: new Set(token.accepted_risks),
 *     token_denied_risks: new Set(token.denied_risks ?? []),
 *     catalog: providerCatalogs[provider],
 *   });
 *   if (decision.outcome === 'allowed') { ... } else { return 403 ... }
 */
export function evaluateCall(input: EvaluateCallInput): RiskDecision {
  const { executed_slices, token_accepted_risks, token_denied_risks, catalog, bindings } = input;

  if (executed_slices.length === 0) {
    return {
      outcome: 'denied',
      missing_risks: [],
      covered_risks: [],
      executed_slices,
      hint: 'plugin returned no slice for this call — classification gap, refusing by default',
    };
  }

  // Compute risks_touched per slice and qualify with the binding env when
  // available. Without env qualification, a token granted
  // `supabase[staging].bulk-row-write` would NEVER match a runtime
  // `supabase.bulk-row-write` from the catalog → silent deny.
  const seen = new Set<RiskId>();
  const risks_touched: RiskId[] = [];
  for (const slice of executed_slices) {
    const env = bindings ? resolveSliceBindingEnv(slice, bindings) : null;
    for (const baseId of risksTouchedBy(slice, catalog)) {
      const entry = findRiskEntry(catalog, baseId);
      // When bindings are present, skip risks whose acceptable_in_envs
      // excludes this binding's env. Without this, overlapping patterns
      // (e.g. two entries sharing the same matches pattern but with
      // disjoint acceptable_in_envs) produce phantom qualified IDs that no token can ever
      // contain. The guard is skipped when bindings are absent (test/legacy
      // mode where env qualification is disabled entirely).
      if (bindings && entry?.acceptable_in_envs && entry.acceptable_in_envs.length > 0) {
        if (env === null || !entry.acceptable_in_envs.includes(env)) {
          continue;
        }
      }
      const qualified = qualifyRiskId(baseId, env, entry);
      if (!seen.has(qualified)) {
        seen.add(qualified);
        risks_touched.push(qualified);
      }
    }
  }

  if (risks_touched.length === 0) {
    return {
      outcome: 'denied',
      missing_risks: [],
      covered_risks: [],
      executed_slices,
      hint:
        `no risk in the '${catalog.provider}' catalog matches the executed slice(s). ` +
        `Add a catalog entry — at minimum extend the '<provider>.uncategorized-*' fallback.`,
    };
  }

  // Explicit denies trump acceptance.
  if (token_denied_risks && token_denied_risks.size > 0) {
    const explicitly_denied = risks_touched.filter((r) => token_denied_risks.has(r));
    if (explicitly_denied.length > 0) {
      return {
        outcome: 'denied',
        missing_risks: explicitly_denied,
        covered_risks: risks_touched.filter((r) => token_accepted_risks.has(r)),
        executed_slices,
        hint:
          `this token explicitly denies [${explicitly_denied.join(', ')}]. ` +
          `Re-mint without the explicit deny, or restrict the operation.`,
      };
    }
  }

  const missing = risks_touched.filter((r) => !token_accepted_risks.has(r));
  if (missing.length > 0) {
    return {
      outcome: 'denied',
      missing_risks: missing,
      covered_risks: risks_touched.filter((r) => token_accepted_risks.has(r)),
      executed_slices,
      hint:
        `this access token is not granted [${missing.join(', ')}]. ` +
        `Executed slice(s): ${executed_slices.map(serializeSlice).join(' ; ')}. ` +
        `Re-mint a token with these risks accepted (or restrict the operation). ` +
        `If the project policy denies these risks, ask an org admin to override.`,
    };
  }

  return { outcome: 'allowed', risks_touched };
}

/**
 * Convenience builder for tests and integration code : wraps a raw
 * `RiskCatalog` in an `IndexedRiskCatalog` and calls evaluateCall.
 * Don't use on the hot-path — pre-index at boot instead.
 */
export function evaluateCallSimple(
  catalog: RiskCatalog,
  slices: readonly Slice[],
  acceptedRisks: readonly RiskId[],
): RiskDecision {
  return evaluateCall({
    executed_slices: slices,
    token_accepted_risks: new Set(acceptedRisks),
    catalog: indexCatalog(catalog),
  });
}
