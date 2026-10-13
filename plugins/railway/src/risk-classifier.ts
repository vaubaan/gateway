/**
 * Legacy v4 entry point of the Railway classifier — deleted in P1.6.
 *
 * `classifyRailwayV4(tool, args, bindings)` keeps the v4 signature
 * (`ProviderBinding[]`) for the v4 gateway pipeline and its tests. It maps
 * each binding to a v5 `Resource`, reproduces the v4 contract ("an explicit
 * `projectId` must be bound"), then delegates slice construction to the v5
 * classifier (`classify.ts`). No classification logic lives here.
 */

import type { Resource, Slice } from '@vaubaan/plugin-sdk';
// legacy v4, deleted in P1.6
import type { ProviderBinding } from '@vaubaan/shared';

import { PROVIDER, classifyRailway, isProjectScopedTool } from './classify.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK (readonly twin). */
export type RailwayClassifyResult = { slices: Slice[] } | { denied: string };

/** @deprecated legacy v4, deleted in P1.6 — use `classifyRailway(tool, args, resources)`. */
export function classifyRailwayV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): RailwayClassifyResult {
  const resources: Resource[] = bindings
    .filter((b) => b.provider === PROVIDER)
    .map((b) => ({
      provider: PROVIDER,
      ref: b.resource_ref,
      env: b.environment ?? null,
      displayName: b.display_name ?? b.resource_ref,
    }));

  if (isProjectScopedTool(tool) && typeof args.projectId === 'string') {
    const projectId = args.projectId;
    if (!resources.some((r) => r.ref === projectId)) {
      return { denied: `railway project '${projectId}' is not bound to this project.` };
    }
  }
  const outcome = classifyRailway(tool, args, resources);
  return 'denied' in outcome ? { denied: outcome.denied } : { slices: [...outcome.slices] };
}
