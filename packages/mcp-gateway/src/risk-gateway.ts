/**
 * Risk-based call path (v4) for the MCP gateway.
 *
 * Spec : docs/spec/gateway-risk-model.md §8 (strict-fail runtime).
 *
 * This module is the v4 sibling of `gateway.ts`. It is a **pure function**
 * (`evaluateCallForToken`) plus a small dispatcher (`shouldUseV4Path`)
 * that the wrapping route uses to decide whether a given access token is
 * v4-shaped (non-empty `accepted_risks`) or v1-shaped (uses `capabilities`).
 *
 * The orchestration (provider lookup, scope-injection, executeCall, audit)
 * stays in the wrapping route — risk-gateway.ts intentionally does NOT
 * call `executeCall` itself. This keeps the v4 module testable in pure
 * units, and lets the v1 gateway.ts handle the lifecycle plumbing
 * unchanged until Phase 3 cutover.
 *
 *  callToolV4 high-level shape (pseudocode) :
 *
 *    const v4Adapter = v4AdaptersByProvider[provider]
 *    const classified = v4Adapter.classifyV4(tool, args, bindings)
 *    if ('denied' in classified) → return 'denied'
 *    const decision = evaluateCall({
 *      executed_slices: classified.slices,
 *      token_accepted_risks: new Set(token.accepted_risks),
 *      token_denied_risks:   new Set(token.denied_risks),
 *      catalog: providerCatalogs[provider],
 *    })
 *    if decision.outcome === 'denied' → return decision  (403 risk-not-accepted)
 *    else → caller proceeds to executeCall + audit (slices, risks_touched)
 */

import type { ProviderBinding, RiskDecision, RiskId, Slice } from '@vaubaan/shared';

import { evaluateCall, type IndexedRiskCatalog } from '@vaubaan/policy-engine';

/** A v4 access-token snapshot — the fields we read in the runtime. */
export interface V4TokenSnapshot {
  readonly id: string;
  readonly accepted_risks: readonly RiskId[];
  readonly denied_risks: readonly RiskId[];
}

/** Verdict that v1 token paths recognize. Distinct from `RiskDecision` so
 *  the wrapping route can decide whether to delegate to the v1 gateway
 *  (capability path) or to refuse on a v4 ground. */
export type CallVerdict =
  | { kind: 'allow'; risks_touched: readonly RiskId[]; executed_slices: readonly Slice[] }
  | {
      kind: 'deny';
      missing_risks: readonly RiskId[];
      executed_slices: readonly Slice[];
      hint: string;
    }
  | { kind: 'classify-denied'; reason: string }
  | { kind: 'no-catalog'; provider: string };

/**
 * Inspect a token snapshot and decide which path applies.
 *
 * Returns `true` iff the token is v4-shaped (accepted_risks non-empty).
 * Tokens with both shapes empty fall through to the v1 path (legacy
 * default-deny behavior preserved). Mixed-shape tokens (both v1 and v4
 * fields set) are forbidden by the mint flow — defensively we treat them
 * as v4 here since the mint flow refuses to create them.
 */
export function shouldUseV4Path(token: { accepted_risks?: readonly RiskId[] | null }): boolean {
  const ar = token.accepted_risks;
  if (!ar) return false;
  return ar.length > 0;
}

/**
 * Minimal v4 adapter shape — what `evaluateCallForToken` needs from the
 * provider plugin. Each provider exports `classifyV4` (see e.g.
 * `@vaubaan/providers-supabase/risk-classifier.ts`).
 */
export interface V4ClassifyResult {
  /** The slice(s) the call touches. */
  slices: Slice[];
}

export type V4ClassifyOutcome = V4ClassifyResult | { denied: string };

export interface V4ClassifierAdapter {
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): V4ClassifyOutcome;
}

/**
 * Pure : classify a call into slices, intersect with the provider catalog,
 * decide allow/deny. The caller wraps this in a Next.js route, does the
 * provider-admin / scope-injection / executeCall / audit work, and emits
 * the JSON-RPC response.
 *
 * `executed_slices` and `risks_touched` are always present on the verdict
 * (for the audit log) — even on `deny` outcomes — so the caller can write
 * them to `audit_log.{slices_executed, risks_touched}` regardless of
 * decision.
 */
export function evaluateCallForToken(input: {
  tool: string;
  args: Record<string, unknown>;
  bindings: ReadonlyArray<ProviderBinding>;
  token: V4TokenSnapshot;
  adapter: V4ClassifierAdapter;
  catalog: IndexedRiskCatalog | undefined;
}): CallVerdict {
  const { tool, args, bindings, token, adapter, catalog } = input;

  if (!catalog) {
    return { kind: 'no-catalog', provider: 'unknown' };
  }

  const classified = adapter.classifyV4(tool, args, bindings);
  if ('denied' in classified) {
    return { kind: 'classify-denied', reason: classified.denied };
  }

  const decision: RiskDecision = evaluateCall({
    executed_slices: classified.slices,
    token_accepted_risks: new Set(token.accepted_risks),
    token_denied_risks: new Set(token.denied_risks),
    catalog,
  });

  if (decision.outcome === 'allowed') {
    return {
      kind: 'allow',
      risks_touched: decision.risks_touched,
      executed_slices: classified.slices,
    };
  }
  return {
    kind: 'deny',
    missing_risks: decision.missing_risks,
    executed_slices: classified.slices,
    hint: decision.hint,
  };
}

/**
 * Format a `CallVerdict` of `kind: 'deny'` into the spec-mandated error
 * body (cf. spec v4 §8 — 403 risk-not-accepted).
 */
export function denyResponseBody(verdict: Extract<CallVerdict, { kind: 'deny' }>): {
  error: 'risk-not-accepted';
  missing_risks: readonly RiskId[];
  executed_slices: readonly Slice[];
  hint: string;
} {
  return {
    error: 'risk-not-accepted',
    missing_risks: verdict.missing_risks,
    executed_slices: verdict.executed_slices,
    hint: verdict.hint,
  };
}
