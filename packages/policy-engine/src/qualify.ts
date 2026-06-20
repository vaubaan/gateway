/**
 * RiskId qualification helpers (env qualifier).
 *
 * Spec : docs/spec/gateway-risk-model.md §4.4.
 *
 * Convention :
 *   `<provider>[<env>].<name>`  — env-scoped (per-binding) form ;
 *   `<provider>.<name>`         — account-scope / non-env-bound form.
 *
 * The catalog YAML stores the **non-qualified** id ; qualification is a
 * presentation / wire concern computed per-binding at mint time, and again
 * at the runtime when we compare `risks_touched` against `accepted_risks`
 * for env-scoped risks.
 *
 * These helpers are PURE — no IO, no globals — so they live in the
 * `@vaubaan/policy-engine` package and are reused by:
 *   - the web mint preview (qualify per binding when listing risks),
 *   - the mint-form client (display + wire format),
 *   - the gateway runtime (`evaluateCallForToken`), to align with the
 *     qualified ids stored on the token's `accepted_risks` snapshot.
 *
 * History : these used to be defined in
 * `packages/web/src/lib/risk-catalog/loader.ts` and re-implemented
 * client-side in `mint-form.tsx`. Centralizing here removed the
 * drift-by-copy hazard flagged in the v4 clean-code report (B3).
 */

import type { ProviderBinding, RiskEntry, RiskId, RiskVector, Slice } from '@vaubaan/shared';

/** Regex for an env qualifier embedded in a RiskId : `[<env-slug>]`. */
const ENV_QUALIFIER_RE = /\[[a-z][a-z0-9-]*\]/;

/** The narrow shape `qualifyRiskId` actually consumes — just the env list.
 *  Accepts `null` as well as `undefined` so UI projections (which use
 *  `readonly string[] | null`) can pass through without an adapter. */
export interface QualifiableRiskEntry {
  readonly acceptable_in_envs?: readonly string[] | null;
}

/**
 * Predicate : is this catalog entry env-scoped ? We use the presence of a
 * non-empty `acceptable_in_envs` as the marker. Account-scope risks
 * (e.g. `github.mint-install-token`) leave the field absent and stay
 * non-qualified across bindings.
 */
export function isEnvScopedEntry(entry: QualifiableRiskEntry | undefined): boolean {
  if (!entry) return false;
  if (!entry.acceptable_in_envs || entry.acceptable_in_envs.length === 0) return false;
  return true;
}

/**
 * Turn a non-env-qualified `RiskId` (e.g. `supabase.bulk-row-write`) into
 * its env-qualified form (`supabase[staging].bulk-row-write`) when the
 * catalog entry declares the risk as env-scoped. Non-env-scoped entries
 * and null/empty envs return the input unchanged.
 *
 * Already-qualified ids are returned unchanged (defensive — callers should
 * not double-qualify, but we don't want to corrupt them either).
 *
 * Note : the entry parameter is `QualifiableRiskEntry`, NOT the full
 * `RiskEntry`. Callers in the UI carry slimmed-down catalog projections
 * (cf. `MintFormCatalogEntry`) — they can pass them in directly without
 * fabricating a fake `matches` field.
 */
export function qualifyRiskId(
  baseId: RiskId,
  env: string | null | undefined,
  entry: QualifiableRiskEntry | undefined,
): RiskId {
  if (env === null || env === undefined || env.length === 0) return baseId;
  if (!isEnvScopedEntry(entry)) return baseId;
  if (ENV_QUALIFIER_RE.test(baseId)) return baseId;
  const dot = baseId.indexOf('.');
  if (dot < 0) return baseId; // shouldn't happen per RiskId regex
  const provider = baseId.slice(0, dot);
  const rest = baseId.slice(dot);
  return `${provider}[${env}]${rest}`;
}

/**
 * Inverse of `qualifyRiskId` — strip the `[env]` qualifier to recover the
 * catalog lookup key. Returns the input unchanged when no env qualifier is
 * present.
 */
export function unqualifyRiskId(qualifiedId: RiskId): RiskId {
  return qualifiedId.replace(ENV_QUALIFIER_RE, '');
}

/**
 * Given an executed slice and the access token's bindings, resolve which
 * binding env (if any) applies to that slice. We match by `slice.provider`
 * and the slice's first `ident` segment value against `binding.resource_ref`.
 *
 * Returns `null` when no match — either the slice is account-rooted
 * (no resource_ref in the path, e.g. `vercel.account.team[…]`) or the
 * provider has no binding on this token. Both cases mean "no env to
 * qualify with".
 *
 * Design note : the resource_ref convention is :
 *  - github   `owner/repo`   appearing as `repo[owner/repo]`
 *  - vercel   `prj_xyz`      appearing as `project[prj_xyz]`
 *  - supabase `xxxxx`        appearing as `project[xxxxx]`
 *  - railway  `pid`          appearing as `project[pid]`
 *  - bash     hostname slug  appearing as `host[<slug>]` or absent
 *
 * The match is structural — first ident in the slice path that equals
 * any `binding.resource_ref` for the slice's provider wins. We don't
 * require a specific entity-name preceding the ident because the spec
 * doesn't pin one ; the providers' classifiers already encode the right
 * shape.
 */
export function resolveSliceBindingEnv(
  slice: Slice,
  bindings: ReadonlyArray<ProviderBinding>,
): string | null {
  const providerBindings = bindings.filter((b) => b.provider === slice.provider);
  if (providerBindings.length === 0) return null;
  // Build a quick lookup ref → env from the provider's bindings.
  const refToEnv = new Map<string, string | null>();
  for (const b of providerBindings) {
    refToEnv.set(b.resource_ref, b.environment ?? null);
  }
  // Walk the slice path, return the first matching ident.
  for (const seg of slice.path) {
    if (seg.kind === 'ident') {
      const env = refToEnv.get(seg.value);
      if (env !== undefined) return env;
    }
  }
  // Slice path didn't carry a binding ref. If the provider has exactly one
  // binding, use that one's env (account-rooted operations still come from
  // a specific account). Multiple bindings + no ref in path = ambiguous → null.
  if (providerBindings.length === 1) {
    return providerBindings[0]!.environment ?? null;
  }
  return null;
}

/**
 * Resolve the effective `RiskVector` for a catalog entry in a given env.
 * When the entry declares `vector_overrides[env]`, the overridden axes
 * replace those in the base `vector` ; absent axes inherit from the base.
 * Returns the base vector unchanged when no override applies.
 *
 * Spec : docs/spec/risk-entry-per-env-vector.md §1.
 */
export function resolveVector(
  entry: Pick<RiskEntry, 'vector' | 'vector_overrides'>,
  env: string | null | undefined,
): RiskVector {
  if (!env || !entry.vector_overrides?.[env]) return entry.vector;
  return { ...entry.vector, ...entry.vector_overrides[env] };
}
