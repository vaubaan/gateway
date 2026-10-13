/**
 * Helpers for `ProviderPlugin.envOf` — deriving a slice's environment from
 * the slice itself.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Resource" ("for providers where
 *        the environment lives in the arguments, the plugin derives it").
 * ADR  : docs/decisions/fallback-risk-only-when-uncategorized.md
 *        (§ environment resolution).
 *
 * The policy engine composes the plugin's `envOf` with the resource labels
 * (`envResolverFor`) : plugin-derived env first, owner label next,
 * unqualified last. Most plugins need no hook at all ; the ones whose data
 * model names the environment as an entity (`vercel.project[p].env[prod]…`)
 * use `envFromSliceSegment('env')`.
 */

import type { Resource, Slice } from '@vaubaan/shared';

/** The shape of `ProviderPlugin.envOf`, usable standalone. */
export type EnvOf = (slice: Slice, resources: readonly Resource[]) => string | undefined;

/**
 * Build an `envOf` that reads the identifier following the named entity
 * segment : with `entity = 'env'`, `vercel.project[p].env[prod].env-var[X].W`
 * yields `prod`. Wildcards and lists in that position yield `undefined`
 * (the slice spans several environments ; the label rule applies, which
 * usually means no qualification). The value is returned as-is : the
 * plugin's classifier is responsible for emitting the owner-facing label.
 */
export function envFromSliceSegment(entity: string): EnvOf {
  return (slice) => {
    for (let i = 0; i < slice.path.length - 1; i += 1) {
      const seg = slice.path[i]!;
      if (seg.kind !== 'name' || seg.value !== entity) continue;
      const next = slice.path[i + 1]!;
      return next.kind === 'ident' && !next.value.includes('*') ? next.value : undefined;
    }
    return undefined;
  };
}
