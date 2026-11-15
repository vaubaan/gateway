/**
 * Helpers for `ServicePlugin.envOf` — deriving a slice's environment from
 * the slice itself.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Resource" ("for services where
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

import { NO_SINGLE_ENV } from '@vaubaan/policy-engine';
import type { Resource, Slice } from '@vaubaan/shared';

export { NO_SINGLE_ENV };

/**
 * The shape of `ServicePlugin.envOf`, usable standalone :
 *
 *   a label            the one environment the slice touches ;
 *   `undefined`        the slice says nothing about its environment — the
 *                      owner's label on the resource applies ;
 *   `NO_SINGLE_ENV`    the slice names its environment but not exactly one
 *                      (a wildcard, a list, a glob) — no environment, and the
 *                      label does NOT apply : every env-scoped risk the slice
 *                      touches is refused.
 */
export type EnvOf = (
  slice: Slice,
  resources: readonly Resource[],
) => string | undefined | typeof NO_SINGLE_ENV;

/**
 * Build an `envOf` that reads the identifier following the named entity
 * segment : with `entity = 'env'`, `vercel.project[p].env[prod].env-var[X].W`
 * yields `prod`. A wildcard, a list or a glob in that position yields
 * `NO_SINGLE_ENV` : the slice spans several environments, and falling back to
 * the owner's label would price a call that reaches `prod` as whatever the
 * resource happens to be labelled. A slice without the entity, or where it
 * is the last segment, yields `undefined` (the label rule applies). The
 * value is returned as-is : the plugin's classifier is responsible for
 * emitting the owner-facing label.
 */
export function envFromSliceSegment(entity: string): EnvOf {
  return (slice) => {
    for (let i = 0; i < slice.path.length - 1; i += 1) {
      const seg = slice.path[i]!;
      if (seg.kind !== 'name' || seg.value !== entity) continue;
      const next = slice.path[i + 1]!;
      // Another entity name follows (`env.something`) : no environment is named.
      if (next.kind === 'name') return undefined;
      return next.kind === 'ident' && !next.value.includes('*') ? next.value : NO_SINGLE_ENV;
    }
    return undefined;
  };
}
