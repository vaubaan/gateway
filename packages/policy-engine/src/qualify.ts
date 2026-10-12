/**
 * RiskId qualification helpers (env qualifier) and environment resolution.
 *
 * Spec : docs/spec/gateway-risk-model.md §4.4 ; docs/spec/vaubaan-gateway.md
 *        §0 "Resource" (environment-qualified RiskIds resolve against the
 *        environment label of the resource a call touches).
 *
 * Convention :
 *   `<provider>[<env>].<name>`  — env-scoped (per-resource) form ;
 *   `<provider>.<name>`         — account-scoped form.
 *
 * The catalog YAML stores the **non-qualified** id ; qualification happens
 * at issuance (one entry per labelled resource) and again at the runtime,
 * when `risks_touched` is compared with the mission's accepted risks.
 *
 * These helpers are PURE — no IO, no globals — and are reused by the
 * issuance UI, the issuance API and the gateway runtime, so the two sides
 * can never drift apart.
 */

import {
  formatRiskId,
  parseRiskId,
  type Resource,
  type RiskEntry,
  type RiskId,
  type RiskVector,
  type Slice,
} from '@vaubaan/shared';

/** The narrow shape `qualifyRiskId` actually consumes — just the env list.
 *  Accepts `null` as well as `undefined` so UI projections (which use
 *  `readonly string[] | null`) can pass through without an adapter. */
export interface QualifiableRiskEntry {
  readonly acceptable_in_envs?: readonly string[] | null;
}

/**
 * Predicate : is this catalog entry env-scoped ? We use the presence of a
 * non-empty `acceptable_in_envs` as the marker. Account-scoped risks
 * (e.g. `github.mint-install-token`) leave the field absent and stay
 * non-qualified across resources.
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
 * `RiskEntry`. Callers in the UI carry slimmed-down catalog projections —
 * they can pass them in directly without fabricating a `matches` field.
 */
export function qualifyRiskId(
  baseId: RiskId,
  env: string | null | undefined,
  entry: QualifiableRiskEntry | undefined,
): RiskId {
  if (env === null || env === undefined || env.length === 0) return baseId;
  if (!isEnvScopedEntry(entry)) return baseId;
  const parsed = parseRiskId(baseId);
  if (!parsed) return baseId; // malformed ids never reach here ; stay defensive
  if (parsed.env !== null) return baseId;
  return formatRiskId({ provider: parsed.provider, env, name: parsed.name });
}

/**
 * Inverse of `qualifyRiskId` — strip the `[env]` qualifier to recover the
 * catalog lookup key. Returns the input unchanged when no env qualifier is
 * present or when the id is malformed.
 */
export function unqualifyRiskId(qualifiedId: RiskId): RiskId {
  const parsed = parseRiskId(qualifiedId);
  if (!parsed || parsed.env === null) return qualifiedId;
  return formatRiskId({ provider: parsed.provider, name: parsed.name });
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment resolution — which env label does an executed slice fall under ?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the environment label an executed slice falls under, or `null`
 * when it has none (account-rooted slice, unlabelled resource, ambiguity).
 *
 * The runtime depends on this interface, not on a resource list, so the
 * host may resolve environments any way it likes : from the mission's
 * resources (the default, `resourceEnvResolver`), from a plugin hook that
 * derives the env from the arguments (GitHub : the branch), or from a
 * fixture in tests.
 */
export interface EnvResolver {
  resolveEnv(slice: Slice): string | null;
}

/** Resolver that never qualifies anything — the test and legacy mode. */
export const noEnvResolver: EnvResolver = {
  resolveEnv: () => null,
};

/**
 * Default resolver : match the slice against the resources the mission may
 * touch. The slice's provider must equal `resource.provider` and the first
 * `ident` segment of the slice path that equals a `resource.ref` wins.
 *
 * Returns `null` when no resource matches — either the slice is
 * account-rooted (no ref in the path, e.g. `vercel.account.team[…]`) or the
 * mission has no resource of that provider. Both mean "no env to qualify
 * with". When the path carries no ref and the mission holds exactly one
 * resource of the provider, that resource's env applies (account-rooted
 * operations still come from a specific account). Several resources and no
 * ref in the path is ambiguous → `null`.
 *
 * Ref conventions are the plugins' : `repo[owner/repo]` for GitHub,
 * `project[prj_xyz]` for Vercel, `project[<ref>]` for Supabase and Railway,
 * `host[<slug>]` for SSH. No entity name is required before the ident ;
 * the classifiers already encode the right shape.
 */
export function resourceEnvResolver(resources: ReadonlyArray<Resource>): EnvResolver {
  return {
    resolveEnv(slice: Slice): string | null {
      const matching = resources.filter((r) => r.provider === slice.provider);
      if (matching.length === 0) return null;
      const refToEnv = new Map<string, string | null>();
      for (const r of matching) refToEnv.set(r.ref, r.env ?? null);
      for (const seg of slice.path) {
        if (seg.kind === 'ident') {
          const env = refToEnv.get(seg.value);
          if (env !== undefined) return env;
        }
      }
      if (matching.length === 1) return matching[0]!.env ?? null;
      return null;
    },
  };
}

/**
 * Resolve the effective `RiskVector` for a catalog entry in a given env.
 * When the entry declares `vector_overrides[env]`, the overridden axes
 * replace those in the base `vector` ; absent axes inherit from the base.
 * Returns the base vector unchanged when no override applies.
 */
export function resolveVector(
  entry: Pick<RiskEntry, 'vector' | 'vector_overrides'>,
  env: string | null | undefined,
): RiskVector {
  if (!env || !entry.vector_overrides?.[env]) return entry.vector;
  return { ...entry.vector, ...entry.vector_overrides[env] };
}
