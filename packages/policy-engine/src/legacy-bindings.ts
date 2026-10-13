/**
 * LEGACY v4 bridge — `ProviderBinding[]` → `EnvResolver`.
 *
 * The v4 gateway pipeline (`@vaubaan/gateway-core`, rewritten in P1.6) and
 * the not-yet-migrated plugins still carry bindings. This bridge lets them
 * call `evaluateCall` unchanged while the runtime itself only knows
 * `Resource` and `EnvResolver`. Deleted with `@vaubaan/shared`'s
 * `legacy-v4.ts` once the last consumer migrates (P1.2 / P1.6).
 */

import type { ProviderBinding, Resource } from '@vaubaan/shared';

import { resourceEnvResolver, type EnvResolver } from './qualify.ts';

/** @deprecated map a v4 binding onto the v5 `Resource` shape. */
export function resourceFromBinding(binding: ProviderBinding): Resource {
  return {
    provider: binding.provider,
    ref: binding.resource_ref,
    env: binding.environment ?? null,
    displayName: binding.display_name ?? binding.resource_ref,
    ...(binding.metadata ? { metadata: binding.metadata } : {}),
  };
}

/** @deprecated use `resourceEnvResolver(resources)`. */
export function bindingsEnvResolver(bindings: ReadonlyArray<ProviderBinding>): EnvResolver {
  return resourceEnvResolver(bindings.map(resourceFromBinding));
}
