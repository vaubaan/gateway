/**
 * Legacy v4 classifier shim — `classifyGmailV4(tool, args, bindings)`.
 *
 * @deprecated legacy v4, deleted in P1.6. The v5 classifier is
 * `classifyGmail(tool, args, resources)` in `classify.ts` ; this module maps
 * v4 `ProviderBinding[]` onto `Resource[]` and keeps the v4 denial wording so
 * the v4 gateway pipeline and its tests run unchanged. Like v4, it classifies
 * against the **first** gmail binding when several are attached.
 */

import type { Resource, Slice } from '@vaubaan/plugin-sdk';
import type { ProviderBinding } from '@vaubaan/shared';

import { classifyGmail } from './classify.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome`. */
export type ClassifyResult = { slices: Slice[] } | { denied: string };

function bindingToResource(binding: ProviderBinding): Resource {
  return {
    provider: binding.provider,
    ref: binding.resource_ref,
    env: binding.environment ?? null,
    displayName: binding.display_name ?? binding.resource_ref,
    ...(binding.metadata ? { metadata: binding.metadata } : {}),
  };
}

/** @deprecated legacy v4, deleted in P1.6 — use `classifyGmail`. */
export function classifyGmailV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const first = bindings.find((b) => b.provider === 'gmail');
  if (!first) return { denied: 'no gmail binding is attached to this token.' };
  const out = classifyGmail(tool, args, [bindingToResource(first)]);
  return 'denied' in out ? { denied: out.denied } : { slices: [...out.slices] };
}
