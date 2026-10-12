---
title: Policy engine
status: current
date: 2026-10-13
tracks:
  - packages/policy-engine/src/slice-dsl.ts
  - packages/policy-engine/src/slice-matcher.ts
  - packages/policy-engine/src/risk-evaluator.ts
  - packages/policy-engine/src/risk-policy.ts
  - packages/policy-engine/src/risk-runtime.ts
  - packages/policy-engine/src/qualify.ts
  - packages/policy-engine/src/legacy-bindings.ts
  - packages/policy-engine/src/scope-injection.ts
  - packages/policy-engine/tests/unit/
---

# Policy engine — `@vaubaan/policy-engine`

Pure modules around **slices** and **risk catalogs** (spec
[`gateway-risk-model.md`](../spec/gateway-risk-model.md) §3, §4, §8 ;
[`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §4.1). No IO, no state :
the gateway feeds it parsed objects (`IndexedRiskCatalog`, `Slice[]`,
`Resource[]`) and gets a decision back. The only dependency is
`@vaubaan/shared`.

Rewritten in English at P0.2 (ADR [[plugin-contract-and-credential-spec]]
D3, D8) : the engine now resolves environments through an `EnvResolver`
over v5 `Resource`s instead of v4 bindings, and two v4 modules are
quarantined.

## Modules

| Module               | Responsibility                                                                                                                         | Called from                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `slice-dsl.ts`       | Parse / serialize the slice grammar (path on the data model + action `R`/`W`).                                                         | catalog loader (SDK), classifiers, audit, tests    |
| `slice-matcher.ts`   | Predicates `matches` / `covers` / `intersects` between slice patterns.                                                                 | `risk-evaluator`, lints                            |
| `risk-evaluator.ts`  | `indexCatalog` (parse every `matches` once, unique ids) + `risksTouchedBy[All]` for executed slices.                                   | `risk-runtime`, SDK registry, test kit             |
| `risk-policy.ts`     | `checkAcceptableInEnv` (issuance-time structural restriction) + `prepareCatalog` (boot checks, injectable `warn`) + `hasFallbackRisk`. | SDK catalog loader, issuance                       |
| `qualify.ts`         | Env-qualify a `RiskId` (`provider.name` → `provider[env].name`) and back ; `EnvResolver` + `resourceEnvResolver` ; `resolveVector`.    | `risk-runtime`, issuance UI, SDK                   |
| `risk-runtime.ts`    | `evaluateCall` — the pure risk step of the call decision : strict-fail if `risks_touched ⊄ accepted`.                                  | gateway-core (execution door)                      |
| `legacy-bindings.ts` | **Quarantined.** `bindingsEnvResolver(ProviderBinding[])` bridge for the v4 pipeline. Deleted at P1.6.                                 | gateway-core v4 `risk-gateway.ts` (via `bindings`) |
| `scope-injection.ts` | **Quarantined.** v4 auto-fill of owner/repo, projectId, project_ref, teamId. Returns `null` unless `{ enabled: true }` (plan §8-Q4).   | gateway-core v4 `gateway.ts`                       |

The barrel `src/index.ts` re-exports all eight.

```
packages/policy-engine/
  src/
    slice-dsl.ts          parseSlice / serializeSlice / SliceParseError
    slice-matcher.ts      matches / covers / intersects
    risk-evaluator.ts     indexCatalog / risksTouchedBy / risksTouchedByAll / findRiskEntry
    risk-policy.ts        checkAcceptableInEnv / prepareCatalog / hasFallbackRisk / fallbackRiskPrefix
    qualify.ts            isEnvScopedEntry / qualifyRiskId / unqualifyRiskId / EnvResolver /
                          noEnvResolver / resourceEnvResolver / resolveVector
    risk-runtime.ts       evaluateCall / evaluateCallSimple
    legacy-bindings.ts    resourceFromBinding / bindingsEnvResolver            (quarantine)
    scope-injection.ts    injectionPlanFor / stripInjectedArgs / mergeInjectedArgs (quarantine, flag)
  tests/unit/
    slice-dsl (23)  slice-matcher (26)  risk-evaluator (11)  risk-policy (8)
    qualify (21)    risk-runtime (16)   scope-injection (13)
```

## Decision flow

```mermaid
flowchart TD
  call["tools/call (tool, args)"] --> classify["plugin.classify(tool, args, resources)"]
  classify --> slices["slices: Slice[]"]
  slices --> touched["for each slice: risksTouchedBy(slice, catalog)<br/>env = envResolver.resolveEnv(slice)<br/>skip if acceptable_in_envs excludes env<br/>qualifyRiskId(id, env, entry)"]
  touched --> check{"risks_touched ⊆ accepted_risks ?"}
  check -->|"yes"| allow["allowed → budget, gate, execute, audit (gateway-core)"]
  check -->|"no"| deny["denied → risk-not-accepted (missing_risks, executed_slices, hint)"]
```

The runtime is **stateless**. Budget, rate limit and gate are evaluated by
the gateway after an `allowed` outcome, with session counters as input ;
they never run on a denied call.

## Modules in detail

### `slice-dsl.ts`

`parseSlice(input) → Slice` implements spec §3 :

```
slice    ::= provider '.' segment ('.' segment)* '.' action
segment  ::= ident | '[' inner ']' | '*' | '**'
inner    ::= ident | ident (',' ident)* | '*' | '**'
ident    ::= [a-zA-Z0-9_/-]+   (glob `*` allowed inside brackets)
action   ::= 'R' | 'W'
```

Accepted : `github.repo[sbw-vaubaan/gateway].branch[main].W`,
`supabase.project[**].schema[public].table[users].row[*].R`,
`github.repo[**].branch[feature/*,fix/*].file[**].W`, `github.**.W`.
`serializeSlice` produces the canonical form (no dot between a name and its
bracket, bare `*`/`**` normalized to `[*]`/`[**]`). `SliceParseError`
carries `input`, `position` and a short message.

### `slice-matcher.ts`

- `matches(pattern, concrete)` — the pattern may hold wildcards, the
  concrete slice may not.
- `covers(a, b)` — partial order on patterns : every concrete matched by `b`
  is matched by `a`.
- `intersects(a, b)` — symmetric ; true iff some concrete slice matches
  both. Used by `risksTouchedBy` because a classifier may itself emit a
  wildcard (`service-var[*].W`).

Segment-by-segment matching ; `[**]` consumes zero or more segments with
backtracking ; the in-bracket glob `*` matches `[a-zA-Z0-9_/-]+`. Known
heuristic in glob-vs-glob `intersects` (`expandGlob`) ; not blocking.

### `risk-evaluator.ts`

`indexCatalog(catalog) → IndexedRiskCatalog` parses every `matches` once
(string or list, OR semantics) and enforces id uniqueness and provider
consistency of patterns. `risksTouchedBy(slice, indexed) → RiskId[]`
returns, in catalog order, every entry one of whose patterns intersects the
slice ; empty means the catalog has no fallback for that slice.
`risksTouchedByAll(slices, indexed)` unions and deduplicates.
`findRiskEntry(indexed, id)` is an O(N) lookup, N small.

### `risk-policy.ts`

- `checkAcceptableInEnv(entry, env)` — refuses at issuance when the entry
  declares `acceptable_in_envs` and the resource's environment label is
  absent or not in the list. Returns a message or `null`.
- `prepareCatalog(catalog, { warn? })` — `indexCatalog` + duplicate ids +
  RiskId grammar (`isRiskId` from `@vaubaan/shared`) ; a missing
  `<provider>.uncategorized-*` fallback calls `warn` (default
  `console.warn`). The SDK loader passes a collecting `warn` and turns the
  finding into a hard error ; here it stays a warning so partial catalogs
  can be indexed in tests and tooling.
- `hasFallbackRisk(catalog)`, `fallbackRiskPrefix(provider)`.

### `qualify.ts`

- `isEnvScopedEntry(entry)` — true iff `acceptable_in_envs` is non-empty ;
  that is the marker of an env-scoped risk.
- `qualifyRiskId(baseId, env, entry)` — `supabase.bulk-row-write` →
  `supabase[staging].bulk-row-write` when the entry is env-scoped and `env`
  non-empty ; already-qualified ids and account-scoped entries are returned
  unchanged. `unqualifyRiskId` is the inverse. Both are built on
  `parseRiskId` / `formatRiskId` from `@vaubaan/shared` — no string
  surgery here.
- `EnvResolver { resolveEnv(slice): string | null }` — the runtime's only
  notion of "which environment does this slice fall under".
  `noEnvResolver` never qualifies (test mode). `resourceEnvResolver(resources)`
  applies the v4 rule to v5 `Resource`s : same provider, first `ident`
  segment equal to a `ref` wins ; no ref in the path and exactly one
  resource of the provider → that resource's env ; several resources and no
  ref → `null` (ambiguous). A host may implement another resolver (a plugin
  hook deriving the env from the branch, for GitHub).
- `resolveVector(entry, env)` — base vector with `vector_overrides[env]`
  applied.

### `risk-runtime.ts`

```ts
evaluateCall({
  executed_slices,            // Slice[] from the plugin
  token_accepted_risks,       // ReadonlySet<RiskId> — the keys of the mission policy
  token_denied_risks?,        // explicit opt-outs (v4 tokens) — trump acceptance
  catalog,                    // IndexedRiskCatalog of the provider
  envResolver?,               // resourceEnvResolver(missionResources) ; omitted = no qualification
  bindings?,                  // @deprecated v4 bindings — wrapped by bindingsEnvResolver
}) → RiskDecision
```

```
executed_slices empty                       → denied (classification gap)
risks_touched empty                         → denied (catalog gap — add a fallback)
any touched risk ∈ token_denied_risks       → denied (explicit deny)
risks_touched ⊄ token_accepted_risks        → denied (missing_risks)
otherwise                                   → allowed (risks_touched)
```

When a resolver is given, a risk whose `acceptable_in_envs` excludes the
resolved env is skipped, so overlapping entries with disjoint env lists
never produce phantom qualified ids. The `hint` of a denial says what to do
(ask the mission creator to re-issue, or restrict the operation) ; the
`RefusalCode` and the structured body are gateway-core's job (P0.5).
`evaluateCallSimple(catalog, slices, accepted)` is for tests only.

### Quarantined modules

`legacy-bindings.ts` maps a `ProviderBinding` to a `Resource`
(`resource_ref → ref`, `environment → env`, `display_name → displayName`,
`metadata`) and wraps `resourceEnvResolver`. `risk-runtime` uses it only
when a caller still passes `bindings`. Deleted at P1.6 with the v4
pipeline.

`scope-injection.ts` keeps the v4 behaviour (auto-fill `owner`/`repo`,
`projectId`, `project_ref`, `teamId` when a token has exactly one binding
of the provider) but `injectionPlanFor(provider, scope, flags)` returns
`null` unless `flags.enabled` is true ; the default
`SCOPE_INJECTION_DEFAULT_FLAGS` is `{ enabled: false }`.
`stripInjectedArgs` and `mergeInjectedArgs` are unchanged. The v5
replacement, if plan §8-Q4 says yes, is the plugin hook `normalizeArgs`
behind the SDK's `argNormalization` flag ([[plugin-sdk]]). Nothing else in
v5 may depend on this module.

## Wiring

At boot the plugin SDK loads each YAML catalog and the registry calls
`prepareCatalog` ; the execution door then evaluates :

```ts
import { evaluateCall, resourceEnvResolver } from '@vaubaan/policy-engine';

const outcome = plugin.classify(tool, args, missionResources);
if ('denied' in outcome) return refuse(outcome.denied);
const decision = evaluateCall({
  executed_slices: outcome.slices,
  token_accepted_risks: new Set(acceptedRisksOf(mission)),
  catalog: registry.catalogOf(providerId),
  envResolver: resourceEnvResolver(missionResources),
});
if (decision.outcome === 'allowed') {
  /* budget, gate, execute, audit */
} else {
  /* risk-not-accepted */
}
```

The v4 `gateway-core` still calls `evaluateCall({ …, bindings })` ; it keeps
working through the bridge until P1.6.

## How to debug

- **`risks_touched` empty, slice looks right** — no catalog pattern
  intersects it, not even the fallback. Check the slice against the
  plugin's `dataModel` ; the fallback `<provider>.**.W` catches writes only,
  reads need their own entry.
- **Denied although the risk is accepted** — qualification mismatch. The
  mission stores `supabase[staging].bulk-row-write` ; the runtime qualifies
  with the env the resolver returns. Is the resource labelled ? Does the
  slice path carry the resource `ref` ? Is the entry env-scoped
  (non-empty `acceptable_in_envs`) ? An account-scoped entry is never
  qualified and must be accepted unqualified.
- **`indexCatalog` / `prepareCatalog` throws at boot** — a `matches` pattern
  is malformed or names another provider ; the message includes the risk id.
  With the SDK loader every issue is listed at once.
- **Scope injection does nothing** — expected : the flag is off. Pass
  `{ enabled: true }` explicitly, and only from v4 code.

## Extension

- **New matching operator** — extend `slice-dsl.ts` (lexer + parser),
  `SliceSegment` in `@vaubaan/shared` `risk.ts`, every `*Segments` /
  `*One` helper of `slice-matcher.ts`, and the matcher tests.
- **Another environment source** — implement `EnvResolver` ; do not touch
  `risk-runtime.ts`.
- **A new structural guardrail at issuance** — a sibling of
  `checkAcceptableInEnv` in `risk-policy.ts`, consumed by the issuance
  path, never by the runtime.

## References

- Spec : [`gateway-risk-model.md`](../spec/gateway-risk-model.md) §3, §4,
  §8 ; [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §3.1, §4.1.
- ADRs : [[plugin-contract-and-credential-spec]],
  [[unified-gates-drop-confirm]], [[scope-caps-amplification-axis]].
- Neighbours : [[plugin-sdk]], [`providers/README.md`](./providers/README.md).
- Tests : `npx vitest run packages/policy-engine` — 118 tests.
