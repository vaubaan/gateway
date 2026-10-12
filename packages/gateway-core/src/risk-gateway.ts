/**
 * Decision core (pure functions).
 *
 * Spec: docs/spec/gateway-risk-model.md §8 (strict-fail runtime);
 * docs/spec/vaubaan-gateway.md §4.1 ("check `risks_touched ⊆ accepted_risks`").
 *
 * `evaluateCallForToken` classifies a call into slices, intersects them with
 * the provider catalog, and produces an allow/deny verdict. Unchanged by the
 * v5 pivot: v5 adds the budget *after* this decision, it does not change
 * which risks are acceptable. The pipeline (`pipeline.ts`) orchestrates
 * around it; keeping this module pure keeps it trivially unit-testable.
 *
 * TODO(P0 merge): `bindings: ProviderBinding[]` is the v4 shape the policy
 * engine still consumes for environment qualification. Feature P0.2 replaces
 * it with `Resource` + `EnvResolver`; the pipeline's risk stage adapts
 * `MissionResource[]` to whatever the engine expects after the merge.
 */

import type { ProviderBinding, RiskDecision, RiskId, Slice } from '@vaubaan/shared';

import { evaluateCall, type IndexedRiskCatalog } from '@vaubaan/policy-engine';

/** What the decision core reads from the credential: the accepted set. */
export interface AcceptedRisksSnapshot {
  readonly id: string;
  readonly accepted_risks: readonly RiskId[];
  /** v4 explicit opt-outs. v5 missions carry none; pass `[]`. */
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

export interface ClassifyResult {
  /** The slice(s) the call touches. */
  slices: Slice[];
}

export type ClassifyOutcome = ClassifyResult | { denied: string };

export interface Classifier {
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyOutcome;
}

/** @deprecated v4 name of {@link AcceptedRisksSnapshot}. */
export type V4TokenSnapshot = AcceptedRisksSnapshot;
/** @deprecated v4 name of {@link ClassifyResult}. */
export type V4ClassifyResult = ClassifyResult;
/** @deprecated v4 name of {@link ClassifyOutcome}. */
export type V4ClassifyOutcome = ClassifyOutcome;
/** @deprecated v4 name of {@link Classifier}. */
export type V4ClassifierAdapter = Classifier;

/**
 * Pure: classify a call into slices, intersect with the provider catalog,
 * decide allow/deny. The caller does the resource, budget, upstream and
 * audit work around it and emits the JSON-RPC response.
 *
 * `executed_slices` and `risks_touched` are always present on the verdict
 * (for the audit entry) — even on `deny` outcomes — so the caller can record
 * them regardless of decision.
 */
export function evaluateCallForToken(input: {
  tool: string;
  args: Record<string, unknown>;
  bindings: ReadonlyArray<ProviderBinding>;
  token: AcceptedRisksSnapshot;
  adapter: Classifier;
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
    // mission that accepted `supabase[staging].bulk-row-write` matches an
    // executed `supabase.bulk-row-write` on the staging resource.
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
 * Format a `CallVerdict` of `kind: 'deny'` into the `risk-not-accepted`
 * body (spec gateway-risk-model §8). Same fields as the v5 refusal of that
 * code; `refuse.riskNotAccepted` in `errors.ts` builds the typed refusal.
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
