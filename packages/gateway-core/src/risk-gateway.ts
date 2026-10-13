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
 * Environments are resolved through the policy engine's `EnvResolver`
 * (ADR plugin-contract-and-credential-spec D3): by default
 * `resourceEnvResolver(resources)` over the mission's resources, so a
 * mission that accepted `supabase[staging].bulk-row-write` matches an
 * executed `supabase.bulk-row-write` on the staging resource. A host may
 * pass another resolver (a plugin deriving the env from a branch).
 */

import type { RefusalCode, Resource, RiskDecision, RiskId, Slice } from '@vaubaan/shared';
import type { ClassifyOutcome, ProviderPlugin } from '@vaubaan/plugin-sdk';

import {
  evaluateCall,
  resourceEnvResolver,
  type EnvResolver,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';

export type { ClassifyOutcome } from '@vaubaan/plugin-sdk';

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
      /** The structured refusal code carried by the engine's decision. */
      code: Extract<RefusalCode, 'risk-not-accepted'>;
      missing_risks: readonly RiskId[];
      /** Every risk the call touched, accepted (covered) or not (missing),
       *  for the audit entry. */
      risks_touched: readonly RiskId[];
      executed_slices: readonly Slice[];
      hint: string;
    }
  | { kind: 'classify-denied'; reason: string }
  | { kind: 'no-catalog'; provider: string };

/**
 * The classification half of the plugin contract: `classify(tool, args,
 * resources)`. A `ProviderPlugin` satisfies it as-is; tests pass a stub.
 */
export type Classifier = Pick<ProviderPlugin, 'classify'>;

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
  args: Readonly<Record<string, unknown>>;
  /** The mission's resources on the connection the call targets. Handed to
   *  the classifier and, unless `envResolver` is given, used to qualify the
   *  touched risks by environment. */
  resources: readonly Resource[];
  token: AcceptedRisksSnapshot;
  adapter: Classifier;
  catalog: IndexedRiskCatalog | undefined;
  /** Defaults to `resourceEnvResolver(resources)`. */
  envResolver?: EnvResolver;
}): CallVerdict {
  const { tool, args, resources, token, adapter, catalog } = input;

  if (!catalog) {
    return { kind: 'no-catalog', provider: 'unknown' };
  }

  const classified: ClassifyOutcome = adapter.classify(tool, args, resources);
  if ('denied' in classified) {
    return { kind: 'classify-denied', reason: classified.denied };
  }

  const decision: RiskDecision = evaluateCall({
    executed_slices: classified.slices,
    token_accepted_risks: new Set(token.accepted_risks),
    token_denied_risks: new Set(token.denied_risks),
    catalog,
    envResolver: input.envResolver ?? resourceEnvResolver(resources),
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
    code: decision.code,
    missing_risks: decision.missing_risks,
    risks_touched: [...decision.covered_risks, ...decision.missing_risks],
    executed_slices: classified.slices,
    hint: decision.hint,
  };
}

/**
 * Format a `CallVerdict` of `kind: 'deny'` into the v4 `risk-not-accepted`
 * body (spec gateway-risk-model §8). Same fields as the v5 refusal of that
 * code; `refuse.riskNotAccepted` in `errors.ts` builds the typed refusal.
 *
 * @deprecated Only the legacy v4 gateway (`apps/gateway/src/lib/gateway/
 * legacy-v4-gateway.ts`) answers in this shape; v5 doors serialize the
 * refusal with `refusalToRpcError`. Deleted with the v4 app at P1.6.
 */
export function denyResponseBody(verdict: Extract<CallVerdict, { kind: 'deny' }>): {
  error: RefusalCode;
  missing_risks: readonly RiskId[];
  executed_slices: readonly Slice[];
  hint: string;
} {
  return {
    error: verdict.code,
    missing_risks: verdict.missing_risks,
    executed_slices: verdict.executed_slices,
    hint: verdict.hint,
  };
}
