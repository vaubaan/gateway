/**
 * `@vaubaan/policy-engine` — pure modules around slices and risk catalogs.
 *
 * Spec : docs/spec/gateway-risk-model.md §3 (DSL), §4 (catalog), §8 (runtime).
 * Handbook : docs/handbook/policy-engine.md.
 */

export * from './slice-dsl.ts';
export * from './slice-matcher.ts';
export * from './risk-evaluator.ts';
export * from './risk-policy.ts';
export * from './risk-runtime.ts';
export * from './qualify.ts';
