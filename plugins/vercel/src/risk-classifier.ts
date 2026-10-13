/**
 * @deprecated legacy v4, deleted in P1.6.
 *
 * `classifyVercelV4(tool, args, bindings)` — the v4 entry point the gateway
 * pipeline still calls with `ProviderBinding[]`. It maps the bindings onto
 * v5 `Resource`s and delegates to `classifyVercel` (`classify.ts`), which is
 * the one classifier. Only the v4 refusal wording for an unbound project is
 * kept here, so the v4 call sites and tests keep their contract.
 */

import type { Resource, Slice } from '@vaubaan/plugin-sdk';
import type { ProviderBinding } from '@vaubaan/shared';

import { classifyVercel, PROVIDER } from './classify.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type ClassifyResult = { slices: Slice[] } | { denied: string };

/** @deprecated legacy v4, deleted in P1.6 — use `vercelPlugin.classify(tool, args, resources)`. */
export function classifyVercelV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const own = bindings.filter((b) => b.provider === PROVIDER);
  const pid = args.projectId ?? args.project_id;
  if (typeof pid === 'string' && pid.length > 0 && !own.some((b) => b.resource_ref === pid)) {
    return { denied: `vercel project '${pid}' is not bound to this project.` };
  }
  const resources: Resource[] = own.map((b) => ({
    provider: PROVIDER,
    ref: b.resource_ref,
    env: b.environment ?? null,
    displayName: b.display_name ?? b.resource_ref,
    ...(b.metadata ? { metadata: b.metadata } : {}),
  }));
  const outcome = classifyVercel(tool, args, resources);
  // The v4 pipeline expects a mutable array.
  return 'denied' in outcome ? { denied: outcome.denied } : { slices: [...outcome.slices] };
}
