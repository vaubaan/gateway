/**
 * `policyFromMacroActions` — the explicit policy a creator writes by ticking
 * macro-actions at trust crans, for plugin tests.
 *
 * Spec : docs/spec/gateway-risk-model.md §4.6 (macro-actions).
 * ADR  : docs/decisions/macro-actions-and-trust-levels-prefill-the-policy.md.
 *
 * It runs the policy engine's own rules (`expandAtCran`, `budgetAtCran`,
 * `qualifyRiskId`, `resolveVector`) the way the creation form does : one line
 * per account-scoped risk, one per environment given for an env-scoped risk
 * acceptable there, deprecated entries left out, a write-token handout asked
 * first. The creator's authority is not modelled : a test holds every risk.
 */

import {
  ANYTHING_ELSE_BASE_BUDGET,
  ANYTHING_ELSE_MACRO_ACTION,
  expandAtCran,
  fallbackEntriesOf,
  isAcceptableInEnv,
  isEnvScopedEntry,
  qualifyRiskId,
  resolveVector,
  unqualifyRiskId,
  type CranCandidate,
  type TrustCran,
} from '@vaubaan/policy-engine';
import type {
  MacroAction,
  MissionPolicyEntry,
  RiskCatalog,
  RiskEntry,
  RiskId,
} from '@vaubaan/shared';

import { writeHandoutRiskIds } from '../define-plugin.ts';
import type { ProviderPlugin } from '../plugin.ts';

/** The cran of each ticked macro-action, by macro-action id (`anything-else` for the fallback). */
export type MacroActionCranChoice = Readonly<Record<string, TrustCran>>;

export interface MacroActionPolicyOptions {
  /**
   * The environment labels the mission's resources carry. An env-scoped risk
   * yields one line per label it is acceptable in, and none without labels.
   */
  readonly envs?: readonly string[];
}

/**
 * The explicit lines of the ticked macro-actions, catalog order, each risk
 * once. Throws on a macro-action id the catalog does not declare, so a test
 * cannot tick a typo and assert on nothing.
 */
export function policyFromMacroActions(
  plugin: Pick<ProviderPlugin, 'catalog' | 'tokenHandouts'>,
  crans: MacroActionCranChoice,
  options: MacroActionPolicyOptions = {},
): MissionPolicyEntry[] {
  const catalog = plugin.catalog;
  const actions = new Map(macroActionsWithFallback(catalog).map((a) => [a.id, a]));
  const byId = new Map(catalog.risks.map((risk) => [risk.id, risk]));
  const writeHandouts = writeHandoutRiskIds(plugin);
  const lines = new Map<RiskId, MissionPolicyEntry>();
  for (const [actionId, cran] of Object.entries(crans)) {
    const action = actions.get(actionId);
    if (!action) {
      throw new Error(
        `policyFromMacroActions: '${actionId}' is not a macro-action of the '${catalog.provider}' catalog`,
      );
    }
    const candidates = action.entries.flatMap((entry) => {
      const risk = byId.get(entry.risk_id);
      if (!risk || risk.deprecated === true) return [];
      const base = { quota: entry.quota, rate_limit: entry.rate_limit };
      return candidatesOf(risk, base, writeHandouts.has(risk.id), options.envs ?? []);
    });
    for (const line of expandAtCran(candidates, cran).lines) {
      lines.set(line.risk_id, {
        risk_id: line.risk_id,
        quota: line.quota,
        rate_limit: line.rate_limit,
        gate: line.gate,
      });
    }
  }
  return catalogOrder(catalog, lines);
}

/** The catalog's macro-actions, then "Anything else" holding its fallback, as the gateway offers them. */
function macroActionsWithFallback(catalog: RiskCatalog): MacroAction[] {
  const own = [...(catalog.macro_actions ?? [])];
  const fallbacks = fallbackEntriesOf(catalog);
  if (fallbacks.length === 0) return own;
  return [
    ...own,
    {
      id: ANYTHING_ELSE_MACRO_ACTION,
      label: 'Anything else',
      description: 'Any write no other permission of this service names.',
      entries: fallbacks.map((risk) => ({ risk_id: risk.id, ...ANYTHING_ELSE_BASE_BUDGET })),
    },
  ];
}

/** One candidate per explicit id of the risk the mission's environments reach. */
function candidatesOf(
  risk: RiskEntry,
  base: CranCandidate['base'],
  handsWriteToken: boolean,
  envs: readonly string[],
): CranCandidate[] {
  const common = {
    base,
    rate_ceiling_per_minute: risk.infra_limits?.calls_per_minute_max ?? null,
    hands_write_token: handsWriteToken,
  };
  if (!isEnvScopedEntry(risk)) return [{ risk_id: risk.id, vector: risk.vector, ...common }];
  return [...new Set(envs)]
    .filter((env) => isAcceptableInEnv(risk, env))
    .map((env) => ({
      risk_id: qualifyRiskId(risk.id, env, risk),
      vector: resolveVector(risk, env),
      ...common,
    }));
}

/** The lines sorted by catalog entry, then by environment as given. */
function catalogOrder(
  catalog: RiskCatalog,
  lines: ReadonlyMap<RiskId, MissionPolicyEntry>,
): MissionPolicyEntry[] {
  const rank = new Map(catalog.risks.map((risk, i) => [risk.id, i]));
  const entries = [...lines.values()];
  const keyOf = (id: RiskId): number => rank.get(unqualifyRiskId(id)) ?? Number.MAX_SAFE_INTEGER;
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => keyOf(a.entry.risk_id) - keyOf(b.entry.risk_id) || a.i - b.i)
    .map(({ entry }) => entry);
}
