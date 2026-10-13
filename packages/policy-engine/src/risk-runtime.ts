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
import { isAcceptableInEnv, qualifyRiskId, type EnvResolver } from './qualify.ts';
import { serializeSlice } from './slice-dsl.ts';

/**
 * The explicit name of the unqualified mode of `evaluateCall` : touched
 * risks keep their catalog id, no environment is resolved and
 * `acceptable_in_envs` is not applied. For catalog tooling and tests only —
 * a host always passes an `EnvResolver`.
 */
export const UNQUALIFIED = 'unqualified';

export interface EvaluateCallInput {
  /** The concrete slice(s) the plugin classified for this call. */
  readonly executed_slices: readonly Slice[];
  /** The mission's accepted risks — the keys of its policy. */
  readonly token_accepted_risks: ReadonlySet<RiskId>;
  /**
   * Explicit opt-outs, when the caller keeps them ; they trump acceptance.
   * Legacy of the v4 token : a v5 mission carries none (spec §4.1 has no
   * explicit deny) and the execution door always passes an empty list.
   * Kept while a caller still passes the field.
   */
  readonly token_denied_risks?: ReadonlySet<RiskId>;
  /** The indexed catalog of the provider in question. */
  readonly catalog: IndexedRiskCatalog;
  /**
   * How the touched risks are env-qualified before the subset check
   * against `token_accepted_risks`, which are stored qualified (spec §4.4).
   *
   *   - an `EnvResolver` — the host mode. Each slice's environment is
   *     resolved, the touched risks are qualified
   *     (`supabase.bulk-row-write` → `supabase[staging].bulk-row-write`)
   *     and an env-scoped risk touched outside its `acceptable_in_envs`
   *     refuses the call. Build one with
   *     `envResolverFor(mission resources, plugin.envOf)`. ANY resolver
   *     object selects this mode — including one that answers `null` for
   *     every slice (`noEnvResolver`), which means "no resource carries an
   *     environment" and therefore refuses every env-scoped risk ;
   *   - `'unqualified'` (`UNQUALIFIED`) — catalog tooling and tests : no
   *     qualification, `acceptable_in_envs` not applied ;
   *   - omitted — the same as `'unqualified'`, kept for existing callers.
   *     New code names the mode.
   */
  readonly envResolver?: EnvResolver | typeof UNQUALIFIED;
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
  const accepted = (r: RiskId): boolean => token_accepted_risks.has(r);

  if (executed_slices.length === 0) {
    return denied(
      executed_slices,
      [],
      [],
      'plugin returned no slice for this call — classification gap, refusing by default',
    );
  }

  const { risks_touched, not_acceptable_here, uncovered } = collectQualifiedRisks(
    executed_slices,
    catalog,
    resolverOf(input),
  );

  // Each slice is something the call does. One that no catalog entry matches is an
  // effect nobody priced: it must not ride on the risks of the slices next to it.
  if (uncovered.length > 0) {
    return denied(
      executed_slices,
      [],
      risks_touched.filter(accepted),
      `no risk in the '${catalog.provider}' catalog matches ${uncovered.map(serializeSlice).join(' ; ')}. ` +
        `Every slice of a call must be covered: add a catalog entry — at minimum extend the '<provider>.uncategorized-*' fallback.`,
    );
  }

  if (not_acceptable_here.length > 0) {
    const refused = new Set(not_acceptable_here.map((r) => r.id));
    return denied(
      executed_slices,
      risks_touched.filter((r) => refused.has(r) || !accepted(r)),
      risks_touched.filter((r) => !refused.has(r) && accepted(r)),
      `${not_acceptable_here.map(describeOutsideItsEnvs).join(' ; ')}. ` +
        `No mission can accept such a risk there: ask the connection owner to label the resource ` +
        `with one of the listed environments if that is what it is, or restrict the operation.`,
    );
  }

  if (risks_touched.length === 0) {
    return denied(
      executed_slices,
      [],
      [],
      `no risk in the '${catalog.provider}' catalog matches the executed slice(s). ` +
        `Add a catalog entry — at minimum extend the '<provider>.uncategorized-*' fallback.`,
    );
  }

  // Explicit denies trump acceptance (legacy input, see `token_denied_risks`).
  const explicitly_denied = risks_touched.filter((r) => token_denied_risks?.has(r) ?? false);
  if (explicitly_denied.length > 0) {
    return denied(
      executed_slices,
      explicitly_denied,
      risks_touched.filter(accepted),
      `this mission explicitly denies [${explicitly_denied.join(', ')}]. ` +
        `Ask the creator to re-issue without the explicit deny, or restrict the operation.`,
    );
  }

  const missing = risks_touched.filter((r) => !accepted(r));
  if (missing.length > 0) {
    return denied(
      executed_slices,
      missing,
      risks_touched.filter(accepted),
      `this mission does not accept [${missing.join(', ')}]. ` +
        `Executed slice(s): ${executed_slices.map(serializeSlice).join(' ; ')}. ` +
        `Ask the mission creator to re-issue with these risks accepted, or restrict the operation.`,
    );
  }

  return { outcome: 'allowed', risks_touched };
}

/** The one shape of a refusal of the risk step. */
function denied(
  executed_slices: readonly Slice[],
  missing_risks: readonly RiskId[],
  covered_risks: readonly RiskId[],
  hint: string,
): RiskDecision {
  return {
    outcome: 'denied',
    code: 'risk-not-accepted',
    missing_risks,
    covered_risks,
    executed_slices,
    hint,
  };
}

/** The resolver of the host mode, or `null` in the unqualified mode. Decided by the input alone. */
function resolverOf(input: EvaluateCallInput): EnvResolver | null {
  const { envResolver } = input;
  return envResolver === undefined || envResolver === UNQUALIFIED ? null : envResolver;
}

interface QualifiedRisks {
  /** Union of the touched risks across the slices, qualified, deduplicated, in stable order. */
  readonly risks_touched: RiskId[];
  /** The touched env-scoped risks whose `acceptable_in_envs` excludes the slice's environment. */
  readonly not_acceptable_here: RiskOutsideItsEnvs[];
  /** The slices no entry of the catalog matches. */
  readonly uncovered: Slice[];
}

/**
 * Compute `risks_touched` per slice and qualify each with the resolved
 * env. Without env qualification, a mission that accepted
 * `supabase[staging].bulk-row-write` would NEVER match a runtime
 * `supabase.bulk-row-write` from the catalog → silent deny.
 *
 * A touched env-scoped risk whose `acceptable_in_envs` excludes the
 * slice's environment (or whose resource carries no label) is NOT dropped:
 * the call still takes that risk, and no mission can hold it there.
 * Dropping it would let a broader co-touched risk carry the call alone —
 * fewer risks required exactly where the catalog says the risk is not
 * acceptable. With no resolver (the unqualified mode) nothing is qualified
 * and nothing is reported.
 */
function collectQualifiedRisks(
  slices: readonly Slice[],
  catalog: IndexedRiskCatalog,
  resolver: EnvResolver | null,
): QualifiedRisks {
  const seen = new Set<RiskId>();
  const risks_touched: RiskId[] = [];
  const not_acceptable_here: RiskOutsideItsEnvs[] = [];
  const uncovered: Slice[] = [];
  for (const slice of slices) {
    const env = resolver === null ? null : resolver.resolveEnv(slice);
    const touched = risksTouchedBy(slice, catalog);
    if (touched.length === 0) uncovered.push(slice);
    for (const baseId of touched) {
      const entry = findRiskEntry(catalog, baseId);
      const qualified = qualifyRiskId(baseId, env, entry);
      if (seen.has(qualified)) continue;
      seen.add(qualified);
      risks_touched.push(qualified);
      if (resolver !== null && !isAcceptableInEnv(entry, env)) {
        not_acceptable_here.push({
          id: qualified,
          env,
          acceptable_in_envs: entry?.acceptable_in_envs ?? [],
        });
      }
    }
  }
  return { risks_touched, not_acceptable_here, uncovered };
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

/**
 * Convenience builder for tests and integration code : wraps a raw
 * `RiskCatalog` in an `IndexedRiskCatalog` and calls evaluateCall in the
 * unqualified mode. Don't use on the hot path — pre-index at boot instead.
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
    envResolver: UNQUALIFIED,
  });
}
