/**
 * Risk-based authorization helpers (pure functions).
 *
 * Spec : docs/spec/gateway-risk-model.md §8 (strict-fail runtime).
 *
 * `evaluateCallForToken` classifies a call into slices, intersects them with
 * the provider catalog, and produces an allow/deny verdict. The wrapping
 * gateway (`gateway.ts`) is responsible for the orchestration (provider
 * lookup, scope-injection, executeCall, audit) — keeping this module pure
 * makes it trivially unit-testable.
 */

import type { ProviderBinding, RiskDecision, RiskId, Slice } from '@vaubaan/shared';

import { evaluateCall, type IndexedRiskCatalog } from '@vaubaan/policy-engine';

/** Access-token snapshot — the fields the runtime reads. */
export interface V4TokenSnapshot {
  readonly id: string;
  readonly accepted_risks: readonly RiskId[];
  readonly denied_risks: readonly RiskId[];
}

/** Verdict returned by `evaluateCallForToken`. */
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
    // Bindings enable env-qualification of touched risks at the runtime, so a
    // token that accepted `supabase[staging].bulk-row-write` matches an
    // executed `supabase.bulk-row-write` on the staging binding. Cf. spec §4.4.
    bindings,
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
