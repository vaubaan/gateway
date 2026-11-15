/**
 * RiskId qualification helpers (env qualifier) and environment resolution.
 *
 * Spec : docs/spec/gateway-risk-model.md §4.4 ; docs/spec/vaubaan-gateway.md
 *        §0 "Resource" (environment-qualified RiskIds resolve against the
 *        environment label of the resource a call touches).
 *
 * Convention :
 *   `<service>[<env>].<name>`  — env-scoped (per-resource) form ;
 *   `<service>.<name>`         — account-scoped form.
 *
 * The catalog YAML stores the **non-qualified** id ; qualification happens
 * at issuance (one entry per labelled resource) and again at the runtime,
 * when `risks_touched` is compared with the mission's accepted risks.
 *
 * These helpers are PURE — no IO, no globals — and are reused by the
 * issuance UI, the issuance API and the gateway runtime, so the two sides
 * can never drift apart.
 */

import type { Resource, RiskEntry, RiskId, RiskVector, Slice } from '@vaubaan/shared';
// Value imports come from the browser-safe subpath : the barrel pulls in
// `api-key.ts` (node:crypto), which the issuance UI cannot bundle.
import { formatRiskId, parseRiskId } from '@vaubaan/shared/risk-id';

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
 * The one rule for "may this risk be accepted or touched in this env" : an
 * entry that is not env-scoped (no list, or an empty one) is acceptable
 * anywhere ; an env-scoped entry only in a listed env, so never without an
 * env. Issuance (`checkAcceptableInEnv`), the runtime (`evaluateCall`) and
 * the gateway's catalog registry all call it.
 */
export function isAcceptableInEnv(
  entry: QualifiableRiskEntry | undefined,
  env: string | null | undefined,
): boolean {
  if (!isEnvScopedEntry(entry)) return true;
  const envs = entry?.acceptable_in_envs ?? [];
  return typeof env === 'string' && envs.includes(env);
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
  return formatRiskId({ service: parsed.service, env, name: parsed.name });
}

/**
 * Inverse of `qualifyRiskId` — strip the `[env]` qualifier to recover the
 * catalog lookup key. Returns the input unchanged when no env qualifier is
 * present or when the id is malformed.
 */
export function unqualifyRiskId(qualifiedId: RiskId): RiskId {
  const parsed = parseRiskId(qualifiedId);
  if (!parsed || parsed.env === null) return qualifiedId;
  return formatRiskId({ service: parsed.service, name: parsed.name });
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment resolution — which env label does an executed slice fall under ?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the environment label an executed slice falls under, or `null`
 * when it has none (account-rooted slice, unlabelled resource, ambiguity).
 *
 * The runtime depends on this interface, not on a resource list, so the
 * host may resolve environments any way it likes : from the plugin's
 * `envOf` hook composed with the mission's resources (`envResolverFor`,
 * the default), from the resources alone (`resourceEnvResolver`), or from
 * a fixture in tests.
 */
export interface EnvResolver {
  resolveEnv(slice: Slice): string | null;
}

/**
 * Resolver that knows no environment : every slice resolves to `null`.
 * It is an ordinary resolver, not a switch — `evaluateCall` given this one
 * runs in the host mode and refuses every env-scoped risk (nothing is
 * labelled). The mode without qualification is requested by name :
 * `envResolver: 'unqualified'`.
 */
export const noEnvResolver: EnvResolver = {
  resolveEnv: () => null,
};

/**
 * Default resolver : match the slice against the resources the mission may
 * touch. The slice's service must equal `resource.service` ; the
 * identifiers of the slice path (`ident` segments and `list` entries) that
 * equal a `resource.ref` name the resources the slice touches, and their
 * environment is the answer **when they all carry the same one**.
 *
 * The resolver cannot know which segment of a slice is the resource : every
 * identifier is compared. So an identifier a caller chose (a table, a key, a
 * branch) that happens to equal the ref of another resource is counted too,
 * and when the cited resources disagree — two labels, or a labelled and an
 * unlabelled one — the answer is `null` : no environment, hence a refusal of
 * every env-scoped risk the call touches. Taking the first match instead
 * would let such an identifier lend its resource's label to the call.
 *
 * Returns `null` when no resource matches — either the slice is
 * account-rooted (no ref in the path, e.g. `vercel.account.team[…]`) or the
 * mission has no resource of that service. Both mean "no env to qualify
 * with". When the path carries no ref and the mission holds exactly one
 * resource of the service, that resource's env applies (account-rooted
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
      const matching = resources.filter((r) => r.service === slice.service);
      if (matching.length === 0) return null;
      const refToEnv = new Map<string, string | null>();
      for (const r of matching) refToEnv.set(r.ref, r.env ?? null);
      const cited = new Set<string | null>();
      for (const seg of slice.path) {
        const values = seg.kind === 'ident' ? [seg.value] : seg.kind === 'list' ? seg.values : [];
        for (const value of values) {
          const env = refToEnv.get(value);
          if (env !== undefined) cited.add(env);
        }
      }
      if (cited.size === 1) return [...cited][0] ?? null;
      // Resources that disagree on the environment : none can be named.
      if (cited.size > 1) return null;
      if (matching.length === 1) return matching[0]!.env ?? null;
      return null;
    },
  };
}

/**
 * What an `EnvDeriver` answers for a slice that names its environment but
 * not exactly one — `env[*]`, `env[prod,preview]`, `env[prod*]` : the slice
 * has no single environment, and the owner's label on the resource must not
 * stand in for it (the label says what the *resource* is, the slice says the
 * call reaches several environments of it). The composed resolver then
 * answers `null`, and every env-scoped risk the slice touches is refused.
 *
 * A value of its own rather than `null` : `null` and `undefined` both mean
 * "this slice says nothing about its environment, use the label".
 */
export const NO_SINGLE_ENV: unique symbol = Symbol.for('@vaubaan/policy-engine/no-single-env');

/**
 * A plugin-side derivation of the environment of a slice : the `env[prod]`
 * segment for Vercel, the only shipped plugin with one. Returns `undefined` (or
 * `null`) when the slice carries no environment of its own, so the
 * resource label applies, and `NO_SINGLE_ENV` when it names several. Mirrors
 * `ServicePlugin.envOf` in the SDK without importing it (the SDK depends on
 * this package, not the reverse).
 */
export type EnvDeriver = (
  slice: Slice,
  resources: readonly Resource[],
) => string | null | undefined | typeof NO_SINGLE_ENV;

/**
 * The composed default resolver (ADR fallback-risk-only-when-uncategorized,
 * § environment resolution ; spec vaubaan-gateway §0 "Resource" : "for
 * services where the environment lives in the arguments, the plugin
 * derives it") :
 *
 *   1. the plugin's `envOf(slice, resources)` when given and non-empty —
 *      the environment is a slice segment or an argument (Vercel) ;
 *      `NO_SINGLE_ENV` ends the resolution there with `null` : the slice
 *      names several environments and no label may replace them ;
 *   2. else the owner's label on the matching resource
 *      (`resourceEnvResolver`) — Supabase, Railway, and Stripe whose
 *      plugin labels one resource per mode at discovery ;
 *   3. else `null` : the risk stays unqualified.
 *
 * Hosts build it once per call with the plugin's hook :
 * `envResolverFor(missionResources, plugin.envOf?.bind(plugin))`.
 */
export function envResolverFor(
  resources: ReadonlyArray<Resource>,
  derive?: EnvDeriver,
): EnvResolver {
  const byLabel = resourceEnvResolver(resources);
  if (!derive) return byLabel;
  return {
    resolveEnv(slice: Slice): string | null {
      const derived = derive(slice, resources);
      if (derived === NO_SINGLE_ENV) return null;
      if (typeof derived === 'string' && derived.length > 0) return derived;
      return byLabel.resolveEnv(slice);
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
