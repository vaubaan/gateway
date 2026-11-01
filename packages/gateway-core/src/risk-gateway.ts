/**
 * Decision core (pure functions).
 *
 * Spec: docs/spec/gateway-risk-model.md §8 (strict-fail runtime);
 * docs/spec/vaubaan-gateway.md §4.1 ("check `risks_touched ⊆ accepted_risks`").
 *
 * `evaluateCallForMission` classifies a call into slices, intersects them with
 * the provider catalog, and produces an allow/deny verdict. Unchanged by the
 * v5 pivot: v5 adds the budget *after* this decision, it does not change
 * which risks are acceptable. The pipeline (`pipeline.ts`) orchestrates
 * around it; keeping this module pure keeps it trivially unit-testable.
 *
 * Environments are resolved through the policy engine's `EnvResolver`
 * (ADR plugin-contract-and-credential-spec D3, fallback-risk-only-when-
 * uncategorized D4): by default `envResolverFor(resources, adapter.envOf)`
 * — the plugin's own derivation first (Vercel's `env[prod]` segment), the
 * owner's label on the matching resource next, unqualified last — so a
 * mission that accepted `supabase[staging].bulk-row-write` matches an
 * executed `supabase.bulk-row-write` on the staging resource, and one that
 * accepted `vercel[prod].env-var-write` matches a prod env-var write on a
 * project the owner labelled otherwise. A host may still pass another
 * resolver.
 */

import type { RefusalCode, Resource, RiskDecision, RiskId, Slice } from '@vaubaan/shared';
import type { ClassifyConnection, ClassifyOutcome, ProviderPlugin } from '@vaubaan/plugin-sdk';

import {
  envResolverFor,
  evaluateCall,
  type EnvResolver,
  type IndexedRiskCatalog,
  type UNQUALIFIED,
} from '@vaubaan/policy-engine';

export type { ClassifyOutcome } from '@vaubaan/plugin-sdk';

/** What the decision core reads from the mission: the accepted set. */
export interface AcceptedRisksSnapshot {
  readonly id: string;
  readonly accepted_risks: readonly RiskId[];
}

/** Verdict returned by `evaluateCallForMission`. */
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
 * resources)` plus the optional `envOf` derivation. A `ProviderPlugin`
 * satisfies it as-is; tests pass a stub.
 */
export type Classifier = Pick<ProviderPlugin, 'classify' | 'envOf'>;

/**
 * Pure: classify a call into slices, intersect with the provider catalog,
 * decide allow/deny. The caller does the resource, budget, upstream and
 * audit work around it and emits the JSON-RPC response.
 *
 * `executed_slices` and `risks_touched` are always present on the verdict
 * (for the audit entry) — even on `deny` outcomes — so the caller can record
 * them regardless of decision.
 */
export function evaluateCallForMission(input: {
  tool: string;
  args: Readonly<Record<string, unknown>>;
  /** The mission's resources on the connection the call targets. Handed to
   *  the classifier and, unless `envResolver` is given, composed with the
   *  adapter's `envOf` to qualify the touched risks by environment. */
  resources: readonly Resource[];
  /** The public form fields of that connection, handed to the classifier
   *  (`ClassifyConnection`); absent outside a host. */
  connection?: ClassifyConnection;
  mission: AcceptedRisksSnapshot;
  adapter: Classifier;
  catalog: IndexedRiskCatalog | undefined;
  /** Defaults to `envResolverFor(resources, adapter.envOf)`. A resolver
   *  replaces the default; `'unqualified'` asks for the engine's mode
   *  without env qualification (catalog tooling and tests, never a host). */
  envResolver?: EnvResolver | typeof UNQUALIFIED;
}): CallVerdict {
  const { tool, args, resources, mission, adapter, catalog } = input;

  if (!catalog) {
    return { kind: 'no-catalog', provider: 'unknown' };
  }

  const classified: ClassifyOutcome = adapter.classify(tool, args, resources, input.connection);
  if ('denied' in classified) {
    return { kind: 'classify-denied', reason: classified.denied };
  }

  const decision: RiskDecision = evaluateCall({
    executed_slices: classified.slices,
    accepted_risks: new Set(mission.accepted_risks),
    catalog,
    envResolver: input.envResolver ?? envResolverFor(resources, adapter.envOf?.bind(adapter)),
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
