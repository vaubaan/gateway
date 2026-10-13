/**
 * Legacy v4 classifier shim — `classifySupabaseV4(tool, args, bindings)`.
 *
 * @deprecated legacy v4, deleted in P1.6. The v5 classifier is
 * `classifySupabase(tool, args, resources)` in `classify.ts` ; this module
 * maps v4 `ProviderBinding[]` onto `Resource[]` and keeps the v4 denial
 * wording so the v4 gateway pipeline and its tests run unchanged.
 */

import type { Resource, Slice } from '@vaubaan/plugin-sdk';
import type { ProviderBinding } from '@vaubaan/shared';

import { classifySupabase, SUPABASE_CLASSIFIED_TOOLS, SUPABASE_TOOL_PLANES } from './classify.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome`. */
export type ClassifyV4Result = { slices: Slice[] } | { denied: string };

/** @deprecated legacy v4, deleted in P1.6 — use `SUPABASE_CLASSIFIED_TOOLS`. */
export const SUPPORTED_TOOLS: ReadonlyArray<string> = SUPABASE_CLASSIFIED_TOOLS;

/** @deprecated legacy v4, deleted in P1.6 — use `SUPABASE_TOOL_PLANES`. */
export const TOOL_PLANES: Readonly<Record<string, 'db' | 'storage' | 'auth' | 'functions'>> =
  SUPABASE_TOOL_PLANES;

function bindingToResource(binding: ProviderBinding): Resource {
  return {
    provider: binding.provider,
    ref: binding.resource_ref,
    env: binding.environment ?? null,
    displayName: binding.display_name ?? binding.resource_ref,
    ...(binding.metadata ? { metadata: binding.metadata } : {}),
  };
}

/** @deprecated legacy v4, deleted in P1.6 — use `classifySupabase`. */
export function classifySupabaseV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyV4Result {
  const out = classifySupabase(tool, args, bindings.map(bindingToResource));
  if ('denied' in out) {
    return {
      denied: out.denied.replace(
        / is not a resource of this mission\.$/,
        ' is not bound to this access token.',
      ),
    };
  }
  return { slices: [...out.slices] };
}
