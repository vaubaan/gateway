/**
 * @deprecated legacy v4, deleted in P1.6.
 *
 * `classifyUpstashRedisV4(tool, args, bindings)` — the v4 entry point the
 * gateway pipeline still calls with `ProviderBinding[]`. It maps the bindings
 * onto v5 `Resource`s and delegates to `classifyUpstashRedis`
 * (`classify.ts`), which is the one classifier. Only the v4 refusal wording
 * for an unbound database is kept here, so the v4 call sites and tests keep
 * their contract.
 */

import type { Resource, Slice } from '@vaubaan/plugin-sdk';
import type { ProviderBinding } from '@vaubaan/shared';

import { classifyUpstashRedis, PROVIDER } from './classify.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type ClassifyResult = { slices: Slice[] } | { denied: string };

/** @deprecated legacy v4, deleted in P1.6 — use `upstashRedisPlugin.classify(tool, args, resources)`. */
export function classifyUpstashRedisV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const own = bindings.filter((b) => b.provider === PROVIDER);
  const dbId = args.databaseId ?? args.database_id;
  if (typeof dbId === 'string' && dbId.length > 0 && !own.some((b) => b.resource_ref === dbId)) {
    return { denied: `upstash-redis database '${dbId}' is not bound to this project.` };
  }
  const resources: Resource[] = own.map((b) => ({
    provider: PROVIDER,
    ref: b.resource_ref,
    env: b.environment ?? null,
    displayName: b.display_name ?? b.resource_ref,
    ...(b.metadata ? { metadata: b.metadata } : {}),
  }));
  const outcome = classifyUpstashRedis(tool, args, resources);
  // The v4 pipeline expects a mutable array.
  return 'denied' in outcome ? { denied: outcome.denied } : { slices: [...outcome.slices] };
}
