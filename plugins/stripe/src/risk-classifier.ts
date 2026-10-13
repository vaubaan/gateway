/**
 * LEGACY v4 classifier entry point — `(tool, args, bindings)`.
 *
 * Kept so the v4 gateway pipeline (`apps/gateway/src/lib/gateway/build.ts`)
 * compiles until P1.6 rewrites the execution door. It maps the first Stripe
 * `ProviderBinding` onto a v5 `Resource` and delegates to `classifyStripe`,
 * while keeping the v4 surface frozen : only the 25 tools v4 listed are
 * known here, and the v4 denial messages are preserved.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `classifyStripe` from `./classify.ts`.
 */

import type { ClassifyOutcome, Resource } from '@vaubaan/plugin-sdk';
import type { ProviderBinding } from '@vaubaan/shared';

import { classifyStripe } from './classify.ts';
import { STRIPE_PROVIDER } from './resources.ts';
import { availableTools } from './tools.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome`. */
export type ClassifyResult = ClassifyOutcome;

const V4_TOOL_NAMES: ReadonlySet<string> = new Set(availableTools.map((t) => t.name));

/** @deprecated legacy v4, deleted in P1.6 — use `classifyStripe(tool, args, resources)`. */
export function classifyStripeV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const binding = bindings.find((b) => b.provider === STRIPE_PROVIDER);
  if (!binding) return { denied: 'no stripe binding is attached to this token.' };
  if (!V4_TOOL_NAMES.has(tool)) return { denied: `unknown stripe tool '${tool}'.` };
  if (typeof binding.resource_ref !== 'string' || binding.resource_ref.length === 0) {
    return { denied: 'stripe binding has no resource_ref (account id).' };
  }
  const resource: Resource = {
    provider: STRIPE_PROVIDER,
    ref: binding.resource_ref,
    env: binding.environment ?? null,
    displayName: binding.display_name ?? binding.resource_ref,
  };
  return classifyStripe(tool, args, [resource]);
}
