/**
 * `@vaubaan/policy-engine` — pure modules around slices and risk catalogs.
 *
 * Spec : docs/spec/gateway-risk-model.md §3 (DSL), §4 (catalog), §8 (runtime).
 * Handbook : docs/handbook/policy-engine.md.
 */

// The public API, named: what the other packages and the applications import.
// A name missing here is internal to the package (structural test: no `export *`).
export { BRACKET_IDENT_CHAR_CLASS, parseSlice, serializeSlice } from './slice-dsl.ts';
export { matches } from './slice-matcher.ts';
export {
  fallbackEntriesOf,
  fallbackRiskPrefix,
  findRiskEntry,
  hasCatchAllWritePattern,
  indexCatalog,
  isFallbackEntry,
  risksTouchedBy,
  risksTouchedByAll,
} from './risk-evaluator.ts';
export type { IndexedRiskCatalog } from './risk-evaluator.ts';
export { prepareCatalog } from './risk-policy.ts';
export { budgetIssues, exceedsRateCeiling, isValidBudget, ratePerMinute } from './budget.ts';
export type { BudgetField } from './budget.ts';
export {
  carriesGlobIdentifier,
  evaluateCall,
  type EvaluateCallInput,
  UNQUALIFIED,
} from './risk-runtime.ts';
export {
  envResolverFor,
  isAcceptableInEnv,
  isEnvScopedEntry,
  NO_SINGLE_ENV,
  noEnvResolver,
  qualifyRiskId,
  resolveVector,
  resourceEnvResolver,
  unqualifyRiskId,
} from './qualify.ts';
export type { EnvResolver } from './qualify.ts';
export {
  ANYTHING_ELSE_BASE_BUDGET,
  ANYTHING_ELSE_MACRO_ACTION,
  budgetAtTrustLevel,
  DEFAULT_TRUST_LEVEL,
  expandAtTrustLevel,
  isTrustLevel,
  macroActionsOf,
  REASON_AXIS,
  REASONS,
  reasonOf,
  ROW_OF_REASON,
  rowOf,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  TRUST_LEVELS,
} from './trust-level.ts';
export {
  ALLOW_WORDS,
  GATE_WORDS,
  gateWordOf,
  REASON_WORDS,
  ROW_GATE_SENTENCES,
  ROW_LABEL,
  ROW_WORDS,
  TREE_LEGEND,
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  WHY_LABELS,
  WHY_ORDER,
  WHY_VALUES,
  whyValue,
} from './risk-words.ts';
export type { GateWord, WhyAxis } from './risk-words.ts';
export type {
  Reason,
  Row,
  TrustLevel,
  TrustLevelCandidate,
  TrustLevelLine,
} from './trust-level.ts';
