/**
 * The semantic rules of a risk catalog — fallback, wildcards, macro-actions
 * and their base budgets. They run on every catalog, YAML or TypeScript :
 * the loader applies them after the structure (`catalog-loader.ts`),
 * `definePlugin`, the registry and the test kit apply them to a catalog
 * built in code. The budget rule itself is `budgetIssues` of the policy
 * engine, shared with the application.
 *
 * Spec : docs/spec/gateway-risk-model.md §4.3 (mandatory fallback), §4.6
 *        (macro-actions : every entry in exactly one, each with a base budget).
 * ADR  : docs/decisions/fallback-risk-only-when-uncategorized.md ;
 *        docs/decisions/macro-actions-and-trust-crans-prefill-the-policy.md.
 */

import {
  ANYTHING_ELSE_MACRO_ACTION,
  budgetIssues,
  fallbackEntriesOf,
  fallbackRiskPrefix,
  hasCatchAllWritePattern,
} from '@vaubaan/policy-engine';
import { WILDCARD_CHARS, type RiskCatalog, type RiskEntry } from '@vaubaan/shared';

/** What a catalog that still carries `presets` reads (spec §15). */
export const RETIRED_PRESETS_ISSUE =
  'presets: presets were retired (ADR macro-actions-and-trust-crans-prefill-the-policy) ; group the risks in macro_actions and remove the presets key';

/** Which of the rules below may be waived : a catalog under construction, a test fixture. */
export interface SemanticOptions {
  /** Fail when no `<provider>.uncategorized-*` entry exists. Default true (risk-model spec §4.3). */
  readonly requireFallback?: boolean;
  /** Fail when the catalog declares no macro-action. Default true (ADR macro-actions-and-trust-crans-prefill-the-policy). */
  readonly requireMacroActions?: boolean;
}

/** Issues beyond structure : fallback, macro-actions, wildcards. Empty array = valid. */
export function semanticIssues(catalog: RiskCatalog, options: SemanticOptions = {}): string[] {
  const issues: string[] = [];
  const requireFallback = options.requireFallback ?? true;
  const requireMacroActions = options.requireMacroActions ?? true;
  // A catalog built in code skips the parser : it must not carry presets either.
  if (Object.hasOwn(catalog, 'presets')) issues.push(RETIRED_PRESETS_ISSUE);
  issues.push(...fallbackIssues(catalog, { requireFallback }));
  issues.push(...wildcardIssues(catalog));
  issues.push(...macroActionIssues(catalog, { requireMacroActions }));
  return issues;
}

export { ANYTHING_ELSE_MACRO_ACTION };

/**
 * Macro-action rules (ADR macro-actions-and-trust-crans-prefill-the-policy) :
 * unique slugs, none named `anything-else` ; each non-empty ; each entry an
 * unqualified, non-fallback risk of this catalog with a valid base budget ;
 * every entry that is neither the fallback nor deprecated in exactly one
 * macro-action.
 */
export function macroActionIssues(
  catalog: RiskCatalog,
  options: { readonly requireMacroActions?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const actions = catalog.macro_actions ?? [];
  if (actions.length === 0) {
    if (options.requireMacroActions ?? true) {
      issues.push(
        'macro_actions: every catalog groups its risks into macro-actions (ADR macro-actions-and-trust-crans-prefill-the-policy)',
      );
    }
    return issues;
  }
  const byId = new Map<string, RiskEntry>(catalog.risks.map((r) => [r.id, r]));
  const fallbackIds = new Set(fallbackEntriesOf(catalog).map((r) => r.id));
  const owner = new Map<string, string>();
  const actionIds = new Set<string>();
  actions.forEach((action, a) => {
    const at = `macro_actions[${a}]`;
    if (action.id === ANYTHING_ELSE_MACRO_ACTION)
      issues.push(`${at}.id '${action.id}' is the gateway's own macro-action for the fallback`);
    if (actionIds.has(action.id)) issues.push(`${at}.id '${action.id}' is declared twice`);
    actionIds.add(action.id);
    if (action.entries.length === 0) issues.push(`${at}.entries is empty`);
    action.entries.forEach((entry, e) => {
      const where = `${at}.entries[${e}]`;
      issues.push(
        ...budgetIssues({ ...entry, gate: 'auto' }).map((i) => `${where}.${i.field}: ${i.message}`),
      );
      const risk = byId.get(entry.risk_id);
      if (!risk) {
        issues.push(
          `${where}.risk_id '${entry.risk_id}' is not an unqualified risk of the '${catalog.provider}' catalog`,
        );
        return;
      }
      if (fallbackIds.has(risk.id))
        issues.push(
          `${where}.risk_id '${entry.risk_id}' is the fallback, which belongs to no macro-action`,
        );
      const previous = owner.get(entry.risk_id);
      if (previous !== undefined)
        issues.push(
          `${where}.risk_id '${entry.risk_id}' already belongs to macro-action '${previous}'`,
        );
      else owner.set(entry.risk_id, action.id);
    });
  });
  for (const risk of catalog.risks) {
    if (fallbackIds.has(risk.id) || risk.deprecated === true || owner.has(risk.id)) continue;
    issues.push(`risks: '${risk.id}' belongs to no macro-action`);
  }
  return issues;
}

/**
 * Fallback rules (risk-model spec §4.3 ; ADR fallback-risk-only-when-
 * uncategorized) : exactly one fallback entry — `fallback: true`, or
 * detected by the catch-all pattern `<provider>.**.W` or the
 * `<provider>.uncategorized-` id — and that entry is named
 * `<provider>.uncategorized-*`, so audit logs read the same for every
 * provider, and matches the catch-all write `<provider>.**.W`. The pattern
 * is checked because the fallback is the one entry that is left out of the
 * touched risks whenever another entry matches : flagged on a narrow
 * pattern, a named risk would silently stop being required.
 */
export function fallbackIssues(
  catalog: RiskCatalog,
  options: { readonly requireFallback?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const fallbacks = fallbackEntriesOf(catalog);
  const prefix = fallbackRiskPrefix(catalog.provider);
  const catchAll = `${catalog.provider}.**.W`;
  if (fallbacks.length === 0) {
    if (options.requireFallback ?? true) {
      issues.push(
        `missing fallback risk: declare a '${prefix}*' entry matching '${catchAll}' with fallback: true (risk-model spec §4.3)`,
      );
    }
    return issues;
  }
  if (fallbacks.length > 1) {
    issues.push(
      `fallback: exactly one fallback entry per catalog, found ${fallbacks.length} (${fallbacks
        .map((r) => `'${r.id}'`)
        .join(', ')}) — only one entry may be flagged fallback: true or match '${catchAll}'`,
    );
  }
  for (const entry of fallbacks) {
    const i = catalog.risks.indexOf(entry);
    if (!entry.id.startsWith(prefix)) {
      issues.push(`risks[${i}].id '${entry.id}' is the fallback and must be named '${prefix}*'`);
    }
    if (!hasCatchAllWritePattern(entry)) {
      issues.push(
        `risks[${i}].matches: the fallback '${entry.id}' must match the catch-all write '${catchAll}'`,
      );
    }
  }
  return issues;
}

/**
 * The fallback entry must carry `fallback: true` (ADR fallback-risk-only-
 * when-uncategorized D2, as amended) : a reader of the YAML
 * sees that the entry behaves differently, and the runtime never depends on
 * the pattern convention. An entry recognised by convention alone (the
 * `<provider>.**.W` pattern or the `<provider>.uncategorized-` id) is
 * reported here ; the loader surfaces it as a warning so a third-party
 * catalog written before the flag still boots, the test kit
 * (`assertPluginWellFormed`) as a failure.
 */
export function fallbackFlagIssues(catalog: RiskCatalog): string[] {
  return fallbackEntriesOf(catalog)
    .filter((entry) => entry.fallback !== true)
    .map((entry) => {
      const i = catalog.risks.indexOf(entry);
      return `risks[${i}].id '${entry.id}' is the fallback by convention only — set fallback: true on it`;
    });
}

/**
 * Non-fatal findings the loader reports through `warn` : today only
 * `fallbackFlagIssues`. A macro-action that includes the fallback is an
 * error (`macroActionIssues`).
 */
export function catalogWarnings(catalog: RiskCatalog): string[] {
  return fallbackFlagIssues(catalog);
}

/**
 * Risk ids that are patterns or sentinels instead of explicit ids. A
 * macro-action entry must name an unqualified risk of the catalog
 * (`macroActionIssues`), so a wildcard there is reported as unknown.
 */
export function wildcardIssues(catalog: RiskCatalog): string[] {
  return riskIdWildcardIssues(catalog);
}

/** Catalog risk ids that contain a wildcard character. */
export function riskIdWildcardIssues(catalog: RiskCatalog): string[] {
  const issues: string[] = [];
  catalog.risks.forEach((risk, i) => {
    if (WILDCARD_CHARS.test(risk.id))
      issues.push(`risks[${i}].id '${risk.id}' contains a wildcard`);
  });
  return issues;
}
