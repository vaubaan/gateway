/**
 * @deprecated legacy v4 entry point, deleted in P1.6 — use `classifyGithub`
 * from `./classify.ts` (resources instead of bindings).
 *
 * Kept so the v4 gateway (`apps/gateway/src/lib/gateway/build.ts`) and the
 * v4 classifier tests keep compiling and passing unchanged. Thin wrapper :
 * the bindings are reduced to their `owner/repo` refs and handed to the
 * shared core classifier.
 */

import type { ProviderBinding, Slice } from '@vaubaan/shared';

import { classifyGithubRefs } from './classify.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type ClassifyV4Result = { slices: Slice[] } | { denied: string };

/** @deprecated legacy v4, deleted in P1.6 — use `classifyGithub(tool, args, resources)`. */
export function classifyGithubV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: readonly ProviderBinding[],
): ClassifyV4Result {
  const refs: string[] = [];
  for (const b of bindings) {
    if (b.provider === 'github') refs.push(b.resource_ref);
  }
  const outcome = classifyGithubRefs(tool, args, refs);
  return 'denied' in outcome ? { denied: outcome.denied } : { slices: [...outcome.slices] };
}
