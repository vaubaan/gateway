/**
 * What a plugin test needs of the policy engine to decide a call the way
 * the gateway decides it, re-exported so a plugin's tests import the SDK and
 * nothing else (the `no-restricted-imports` rule of `plugins/**`).
 *
 * Spec : docs/spec/gateway-risk-model.md §8 (runtime decision).
 */

import { envResolverFor, evaluateCall, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { Resource, RiskDecision, RiskId } from '@vaubaan/shared';

import type { ClassifyAccount, ServicePlugin } from '../plugin.ts';
import { PluginRegistry } from '../registry.ts';

export {
  envResolverFor,
  evaluateCall,
  indexCatalog,
  isEnvScopedEntry,
  matches,
  noEnvResolver,
  reasonOf,
  rowOf,
  prepareCatalog,
  qualifyRiskId,
  resourceEnvResolver,
  risksTouchedBy,
  risksTouchedByAll,
  UNQUALIFIED,
  type EnvResolver,
  type EvaluateCallInput,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
export type { MissionPolicy, MissionPolicyEntry, RiskDecision } from '@vaubaan/shared';

/** One call, and the mission it is decided under. */
export interface CallUnderTest {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The mission's resources on the account. */
  readonly resources: readonly Resource[];
  /** The risks the mission accepted, qualified as a mission stores them (`acme[prod].widget-write`). */
  readonly accepted: readonly RiskId[];
  /** The account's public form fields, when the classifier reads them. */
  readonly account?: ClassifyAccount;
  /** The plugin's indexed catalog ; built from `plugin.catalog` when absent. */
  readonly catalog?: IndexedRiskCatalog;
}

/** What the gateway decides of a call : the classifier's refusal, or the engine's decision. */
export type CallDecision =
  { readonly outcome: 'classify-denied'; readonly reason: string } | RiskDecision;

/**
 * Decide `call` as the gateway's risk step does : the plugin classifies it,
 * then the engine intersects the touched risks — qualified by the
 * environment `envResolverFor(resources, plugin.envOf)` resolves — with the
 * accepted ones. Neither the budget nor the gate is applied : a test of what
 * a mission allows, not of how much.
 */
export function decideCall(plugin: ServicePlugin, call: CallUnderTest): CallDecision {
  const classified = plugin.classify(call.tool, call.args, call.resources, call.account);
  if ('denied' in classified) return { outcome: 'classify-denied', reason: classified.denied };
  return evaluateCall({
    executed_slices: classified.slices,
    accepted_risks: new Set(call.accepted),
    catalog: call.catalog ?? new PluginRegistry([plugin]).catalogOf(plugin.id),
    envResolver: envResolverFor(call.resources, plugin.envOf?.bind(plugin)),
  });
}
