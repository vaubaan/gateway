/**
 * Risk runtime — the risk step of the per-call authorization decision.
 *
 * Spec : docs/spec/gateway-risk-model.md §8 (strict-fail) ;
 *        docs/spec/vaubaan-gateway.md §4.1 (call pipeline).
 *
 *   1. plugin.classify(tool, args, resources) → slices[]
 *   2. risks_touched = ∪_{slice ∈ slices} risksTouchedBy(slice, catalog),
 *      each id env-qualified through the `EnvResolver`
 *   3. if risks_touched ⊆ mission.accepted_risks → ALLOW (then budget, gate)
 *      else                                      → DENY `risk-not-accepted`
 *
 * This step is **stateless** : it only intersects slices with the catalog
 * and checks set membership. Budget, rate limit and gate are evaluated by
 * the gateway after an `allowed` outcome, with the session counters as
 * input ; they never run on a denied call.
 */

import type { ProviderBinding, RiskCatalog, RiskDecision, RiskId, Slice } from '@vaubaan/shared';

import {
  findRiskEntry,
  indexCatalog,
  risksTouchedBy,
  type IndexedRiskCatalog,
} from './risk-evaluator.ts';
import { bindingsEnvResolver } from './legacy-bindings.ts';
import { noEnvResolver, qualifyRiskId, type EnvResolver } from './qualify.ts';
import { serializeSlice } from './slice-dsl.ts';

export interface EvaluateCallInput {
  /** The concrete slice(s) the plugin classified for this call. */
  readonly executed_slices: readonly Slice[];
  /** The mission's accepted risks — the keys of its policy. */
  readonly token_accepted_risks: ReadonlySet<RiskId>;
  /** Explicit opt-outs, when the caller keeps them (v4 tokens). Trump acceptance. */
  readonly token_denied_risks?: ReadonlySet<RiskId>;
  /** The indexed catalog of the provider in question. */
  readonly catalog: IndexedRiskCatalog;
  /**
   * Resolves the environment label of each executed slice so the runtime
   * can env-qualify the touched risks (`supabase.bulk-row-write` →
   * `supabase[staging].bulk-row-write`) before the subset check against
   * `token_accepted_risks`, which are stored qualified (spec §4.4). Build
   * one with `resourceEnvResolver(mission resources)`. When omitted, no
   * qualification happens and `acceptable_in_envs` is not filtered —
   * the test and legacy mode.
   */
  readonly envResolver?: EnvResolver;
  /** @deprecated v4 bindings ; wrapped by `bindingsEnvResolver`. Ignored when `envResolver` is set. */
  readonly bindings?: ReadonlyArray<ProviderBinding>;
}

/**
 * Stateless per-call decision. Pure function — no IO. Returns a
 * structured `RiskDecision` ready for audit logging and the refusal body.
 *
 * The hot path inside the gateway is :
 *
 *   const decision = evaluateCall({
 *     executed_slices: outcome.slices,
 *     token_accepted_risks: new Set(acceptedRisksOf(mission)),
 *     catalog: registry.catalogOf(provider),
 *     envResolver: resourceEnvResolver(missionResources),
 *   });
 *   if (decision.outcome === 'allowed') { budget, gate, execute } else { refuse }
 */
export function evaluateCall(input: EvaluateCallInput): RiskDecision {
  const { executed_slices, token_accepted_risks, token_denied_risks, catalog } = input;
  const resolver = selectResolver(input);
  const qualifying = resolver !== noEnvResolver;

  if (executed_slices.length === 0) {
    return {
      outcome: 'denied',
      missing_risks: [],
      covered_risks: [],
      executed_slices,
      hint: 'plugin returned no slice for this call — classification gap, refusing by default',
    };
  }

  // Compute risks_touched per slice and qualify with the resolved env.
  // Without env qualification, a mission that accepted
  // `supabase[staging].bulk-row-write` would NEVER match a runtime
  // `supabase.bulk-row-write` from the catalog → silent deny.
  const seen = new Set<RiskId>();
  const risks_touched: RiskId[] = [];
  for (const slice of executed_slices) {
    const env = resolver.resolveEnv(slice);
    for (const baseId of risksTouchedBy(slice, catalog)) {
      const entry = findRiskEntry(catalog, baseId);
      // When resolving envs, skip risks whose acceptable_in_envs excludes
      // this slice's env. Without this, overlapping patterns (two entries
      // sharing a pattern with disjoint acceptable_in_envs) would produce
      // phantom qualified ids that no mission can ever contain. Skipped in
      // the test/legacy mode where env qualification is disabled entirely.
      if (qualifying && entry?.acceptable_in_envs && entry.acceptable_in_envs.length > 0) {
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
          `this mission explicitly denies [${explicitly_denied.join(', ')}]. ` +
          `Ask the creator to re-issue without the explicit deny, or restrict the operation.`,
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
        `this mission does not accept [${missing.join(', ')}]. ` +
        `Executed slice(s): ${executed_slices.map(serializeSlice).join(' ; ')}. ` +
        `Ask the mission creator to re-issue with these risks accepted, or restrict the operation.`,
    };
  }

  return { outcome: 'allowed', risks_touched };
}

function selectResolver(input: EvaluateCallInput): EnvResolver {
  if (input.envResolver) return input.envResolver;
  if (input.bindings) return bindingsEnvResolver(input.bindings);
  return noEnvResolver;
}

/**
 * Convenience builder for tests and integration code : wraps a raw
 * `RiskCatalog` in an `IndexedRiskCatalog` and calls evaluateCall without
 * env qualification. Don't use on the hot path — pre-index at boot instead.
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
