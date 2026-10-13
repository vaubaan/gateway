/**
 * Risk runtime — the risk step of the per-call authorization decision.
 *
 * Spec : docs/spec/gateway-risk-model.md §8 (strict-fail) ;
 *        docs/spec/vaubaan-gateway.md §4.1 (call pipeline).
 *
 *   1. plugin.classify(tool, args, resources) → slices[]
 *   2. risks_touched = ∪_{slice ∈ slices} risksTouchedBy(slice, catalog),
 *      each id env-qualified through the `EnvResolver` ; an env-scoped
 *      risk touched outside its `acceptable_in_envs` (or on an unlabelled
 *      resource) refuses the call — it is never dropped from the set
 *   3. if risks_touched ⊆ mission.accepted_risks → ALLOW (then budget, gate)
 *      else                                      → DENY `risk-not-accepted`
 *
 * This step is **stateless** : it only intersects slices with the catalog
 * and checks set membership. Budget, rate limit and gate are evaluated by
 * the gateway after an `allowed` outcome, with the session counters as
 * input ; they never run on a denied call.
 */

import type { RiskCatalog, RiskDecision, RiskId, Slice } from '@vaubaan/shared';

import {
  findRiskEntry,
  indexCatalog,
  risksTouchedBy,
  type IndexedRiskCatalog,
} from './risk-evaluator.ts';
import { isAcceptableInEnv, noEnvResolver, qualifyRiskId, type EnvResolver } from './qualify.ts';
import { serializeSlice } from './slice-dsl.ts';

export interface EvaluateCallInput {
  /** The concrete slice(s) the plugin classified for this call. */
  readonly executed_slices: readonly Slice[];
  /** The mission's accepted risks — the keys of its policy. */
  readonly token_accepted_risks: ReadonlySet<RiskId>;
  /** Explicit opt-outs, when the caller keeps them. Trump acceptance. v5 missions carry none. */
  readonly token_denied_risks?: ReadonlySet<RiskId>;
  /** The indexed catalog of the provider in question. */
  readonly catalog: IndexedRiskCatalog;
  /**
   * Resolves the environment label of each executed slice so the runtime
   * can env-qualify the touched risks (`supabase.bulk-row-write` →
   * `supabase[staging].bulk-row-write`) before the subset check against
   * `token_accepted_risks`, which are stored qualified (spec §4.4). Build
   * one with `envResolverFor(mission resources, plugin.envOf)`. When omitted, no
   * qualification happens and `acceptable_in_envs` is not filtered —
   * the test mode.
   */
  readonly envResolver?: EnvResolver;
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
 *     envResolver: envResolverFor(missionResources, plugin.envOf),
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
      code: 'risk-not-accepted',
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
  const not_acceptable_here: RiskOutsideItsEnvs[] = [];
  for (const slice of executed_slices) {
    const env = resolver.resolveEnv(slice);
    for (const baseId of risksTouchedBy(slice, catalog)) {
      const entry = findRiskEntry(catalog, baseId);
      const qualified = qualifyRiskId(baseId, env, entry);
      if (seen.has(qualified)) continue;
      seen.add(qualified);
      risks_touched.push(qualified);
      // A touched env-scoped risk whose `acceptable_in_envs` excludes the
      // slice's environment (or whose resource carries no label) is NOT
      // dropped: the call still takes that risk, and no mission can hold
      // it there. Dropping it would let a broader co-touched risk carry
      // the call alone — fewer risks required exactly where the catalog
      // says the risk is not acceptable. Skipped in the test mode, where
      // env qualification is disabled entirely.
      if (qualifying && !isAcceptableInEnv(entry, env)) {
        not_acceptable_here.push({
          id: qualified,
          env,
          acceptable_in_envs: entry?.acceptable_in_envs ?? [],
        });
      }
    }
  }

  if (not_acceptable_here.length > 0) {
    const refused = new Set(not_acceptable_here.map((r) => r.id));
    return {
      outcome: 'denied',
      code: 'risk-not-accepted',
      missing_risks: risks_touched.filter((r) => refused.has(r) || !token_accepted_risks.has(r)),
      covered_risks: risks_touched.filter((r) => !refused.has(r) && token_accepted_risks.has(r)),
      executed_slices,
      hint:
        `${not_acceptable_here.map(describeOutsideItsEnvs).join(' ; ')}. ` +
        `No mission can accept such a risk there: ask the connection owner to label the resource ` +
        `with one of the listed environments if that is what it is, or restrict the operation.`,
    };
  }

  if (risks_touched.length === 0) {
    return {
      outcome: 'denied',
      code: 'risk-not-accepted',
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
        code: 'risk-not-accepted',
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
      code: 'risk-not-accepted',
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

interface RiskOutsideItsEnvs {
  readonly id: RiskId;
  readonly env: string | null;
  readonly acceptable_in_envs: readonly string[];
}

function describeOutsideItsEnvs(risk: RiskOutsideItsEnvs): string {
  const where =
    risk.env === null
      ? 'a resource with no environment label'
      : `a resource labelled '${risk.env}'`;
  const envs = risk.acceptable_in_envs.join(', ');
  return `'${risk.id}' is touched on ${where}, but is acceptable only in [${envs}]`;
}

function selectResolver(input: EvaluateCallInput): EnvResolver {
  return input.envResolver ?? noEnvResolver;
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
