/**
 * Capability evaluation — the authorization decision.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §3, §7.
 *
 * The provider plugin has already classified the concrete (tool, args) call into
 * the capability it *requires* (env resolved). This step is pure set membership :
 * is that required capability covered by the token's granted set ? Coverage is an
 * exact-tuple match (no implicit ladder, no env wildcard) — which is exactly the
 * env defensive filter : a `@prod` requirement needs a `@prod` grant.
 */

import { type Capability, formatCapability, isGranted } from '@vaubaan/shared';

export interface PolicyDecision {
  decision: 'allowed' | 'denied';
  /** Shorthand of the capability that authorized the call (allow only). */
  capabilityMatched?: string;
  /** Actionable denial reason (deny only). */
  reason?: string;
}

export function evaluateCapability(
  granted: readonly Capability[],
  required: Capability,
): PolicyDecision {
  if (isGranted(granted, required)) {
    return { decision: 'allowed', capabilityMatched: formatCapability(required) };
  }
  const need = formatCapability(required);
  const have = granted.length ? granted.map(formatCapability).join(', ') : '(none)';
  return {
    decision: 'denied',
    reason:
      `this access token is not granted '${need}'. ` +
      `Granted capabilities: ${have}. ` +
      `Mint a token carrying '${need}' to perform this call.`,
  };
}
