---
title: Policy engine — slices, catalogs, the risk decision
tracks:
  - packages/policy-engine/src/
  - packages/shared/src/wildcard.ts
  - packages/policy-engine/package.json
last_reviewed: 2026-11-05
---

# Policy engine — handbook

`@vaubaan/policy-engine`: pure functions over slices and risk catalogs; no IO, no state. Spec:
[gateway-risk-model](../spec/gateway-risk-model.md) §3, §4, §8. ADRs:
[fallback-risk-only-when-uncategorized](../decisions/fallback-risk-only-when-uncategorized.md),
[scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md).

## Start here

- [`risk-runtime.ts`](../../packages/policy-engine/src/risk-runtime.ts) — `evaluateCall`, the risk
  step of the call decision.
- [`risk-evaluator.ts`](../../packages/policy-engine/src/risk-evaluator.ts) — catalog index,
  `risksTouchedBy`, fallback detection.
- [`qualify.ts`](../../packages/policy-engine/src/qualify.ts) — environments: qualification and
  the resolvers.
- [`slice-matcher.ts`](../../packages/policy-engine/src/slice-matcher.ts),
  [`budget.ts`](../../packages/policy-engine/src/budget.ts).

## Invariants

- **The barrel names the public API** (`src/index.ts`, no `export *`, **[inv: named-package-barrels]**): a name the other packages need is added there on purpose; the package's own tests import from the module.
- Values come only from the browser-safe subpaths `@vaubaan/shared/risk-id` and `/domain`: the
  issuance UI bundles this package and the barrel pulls in `node:crypto`.
- Severity (`severity.ts`) orders, never decides: `severityOf` is the score that sorts permissions,
  `severityLevel` its word. The gateway's interface and the site call this one function; neither
  restates it. `SEVERITY_RANKS` restates `RISK_VECTOR_AXES` (server-only barrel); a test asserts
  they agree.
- One rule each, called by every consumer: `isAcceptableInEnv` (issuance, runtime, SDK macro-action
  checks, the store's `RegistryCatalogIndex`), `budgetIssues` (SDK loader, `macroActionIssues`,
  issuance preview). Never re-implement them.
- The fallback is touched only when no other entry matched; empty means nothing covers the slice,
  and the call is refused.
- Every slice must be covered, not the union: one uncovered slice denies the call.
- An executed slice carrying `*` inside an identifier is denied before any lookup: a caller's
  value would be read as a glob. Whole-segment wildcards (`[*]`, `[**]`, `ANY_IDENT`) mean
  "every instance" and stay.
- The mode comes from `envResolver` alone: any `EnvResolver` (even `noEnvResolver`) qualifies risks
  and never drops an env-scoped one (it appears in `missing_risks`); `'unqualified'` is for tooling
  and tests only. New code names the mode.
- Environment of a slice: the plugin's `envOf` first, then the resource's label, else none.
  `NO_SINGLE_ENV` (not `null`) for a wildcard or list, so the label is not consulted. No provider
  `switch` here or in gateway-core.

## Traps

- The in-bracket glob is never compiled to a regex (`matchWildcard`, linear): a regex would
  backtrack exponentially and a policy can arrive through the management door.
- Glob × glob `intersects` is exact for one `*` per side and answers `true` (fails closed) beyond.
- `resourceEnvResolver` compares every identifier of the slice with resource refs, so a table or
  branch named like another resource counts; disagreeing labels resolve to `null`, never the first
  match.
- `isFallbackEntry` also recognises `<provider>.uncategorized-` by id (dash included); the SDK
  loader requires the explicit flag and the catch-all write.
- `evaluateCall` reads the mission's `accepted_risks` and nothing else: there is no explicit deny
  (spec §4.1); a risk is refused because it is not accepted.

## Debug

- **`risks_touched` empty** → no pattern intersects, not even the fallback, which catches writes
  only; reads need their own entry.
- **Denied although accepted** → qualification: is the resource labelled, does the slice carry
  its ref, is the entry env-scoped?
- **Env-scoped risk refused on a labelled resource** → the slice names resources with different
  labels, or `envOf` answered `NO_SINGLE_ENV`.
- Tests: `npx vitest run packages/policy-engine`.
